import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { fetch } from "undici";

const config = {
  configDir: resolve(process.env.SERVERSENTINEL_CONFIG_DIR ?? "/config"),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  modrinthApiKey: process.env.MODRINTH_API_KEY ?? "",
  port: Number(process.env.PORT ?? "8080")
};

const serversFile = join(config.configDir, "servers.json");

type AttachedServer = {
  id: string;
  displayName: string;
  serverDir: string;
  minecraftVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  serverType: "fabric";
  createdAt: string;
  updatedAt: string;
};

type PublicServer = Omit<AttachedServer, "serverDir"> & {
  directoryLabel: string;
  hasDockerContainer: boolean;
};

type DockerState = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead" | "unknown";

type Client = {
  send: (payload: string) => void;
  readyState: number;
};

function publicServer(server: AttachedServer): PublicServer {
  return {
    id: server.id,
    displayName: server.displayName,
    minecraftVersion: server.minecraftVersion,
    serverJar: server.serverJar,
    dockerContainer: server.dockerContainer,
    serverType: server.serverType,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    directoryLabel: server.serverDir,
    hasDockerContainer: Boolean(server.dockerContainer)
  };
}

async function readServers() {
  await mkdir(config.configDir, { recursive: true });
  if (!existsSync(serversFile)) {
    await writeFile(serversFile, "[]\n", "utf8");
  }
  const parsed = JSON.parse(await readFile(serversFile, "utf8")) as AttachedServer[];
  return parsed;
}

async function writeServers(servers: AttachedServer[]) {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(serversFile, `${JSON.stringify(servers, null, 2)}\n`, "utf8");
}

async function getServer(serverId?: string) {
  const servers = await readServers();
  const server = serverId ? servers.find((candidate) => candidate.id === serverId) : servers[0];
  if (!server) {
    throw new Error("No attached server is registered");
  }
  return server;
}

function ensureInsideServer(server: AttachedServer, userPath = ".") {
  const serverDir = resolve(server.serverDir);
  const trimmed = userPath.replace(/^[/\\]+/, "");
  const target = resolve(serverDir, trimmed || ".");
  if (target !== serverDir && !target.startsWith(serverDir + sep)) {
    throw new Error("Path escapes the registered server directory");
  }
  return target;
}

function toPublicPath(server: AttachedServer, absolutePath: string) {
  const rel = relative(resolve(server.serverDir), absolutePath).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function safeModFilename(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_");
}

function dockerAvailable() {
  return existsSync(config.dockerSocket);
}

async function dockerRequest<T>(
  method: "GET" | "POST",
  path: string,
  expectedStatus: number | number[] = [200, 204, 304]
): Promise<T> {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(body || `Docker API returned ${response.statusCode}`));
            return;
          }
          resolveRequest(body ? (JSON.parse(body) as T) : ({} as T));
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

async function dockerBufferRequest(method: "GET" | "POST", path: string, expectedStatus: number | number[] = 200) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(body.toString("utf8") || `Docker API returned ${response.statusCode}`));
            return;
          }
          resolveRequest(body);
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

async function dockerStatus(server: AttachedServer) {
  if (!server.dockerContainer) {
    return {
      configured: false,
      available: dockerAvailable(),
      controllable: false,
      state: "unknown" as DockerState,
      message: "No Docker container is configured for this attached server"
    };
  }

  if (!dockerAvailable()) {
    return {
      configured: true,
      available: false,
      controllable: false,
      state: "unknown" as DockerState,
      container: server.dockerContainer,
      message: "Docker socket is not mounted"
    };
  }

  const details = await dockerRequest<{ State?: { Status?: DockerState; Running?: boolean }; Name?: string; Id?: string }>(
    "GET",
    `/containers/${encodeURIComponent(server.dockerContainer)}/json`,
    200
  );
  return {
    configured: true,
    available: true,
    controllable: true,
    state: details.State?.Status ?? "unknown",
    running: Boolean(details.State?.Running),
    container: server.dockerContainer,
    name: details.Name?.replace(/^\//, "")
  };
}

async function dockerAction(server: AttachedServer, action: "start" | "stop" | "restart") {
  if (!server.dockerContainer) {
    throw new Error("Control is not configured for this attached server");
  }
  await dockerRequest("POST", `/containers/${encodeURIComponent(server.dockerContainer)}/${action}`, [200, 204, 304]);
  return dockerStatus(server);
}

async function dockerRecentLogs(server: AttachedServer) {
  if (!server.dockerContainer) {
    throw new Error("Console logs are not configured for this attached server");
  }
  const response = await dockerBufferRequest(
    "GET",
    `/containers/${encodeURIComponent(server.dockerContainer)}/logs?stdout=1&stderr=1&tail=200`,
    200
  );
  return stripDockerLogHeaders(response).toString("utf8");
}

function readFileRange(filePath: string, start: number, end: number) {
  return new Promise<Buffer>((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", rejectRead);
    stream.on("end", () => resolveRead(Buffer.concat(chunks)));
  });
}

async function readLatestServerLog(server: AttachedServer) {
  const logPath = ensureInsideServer(server, "logs/latest.log");
  const logStat = await stat(logPath);
  if (!logStat.isFile()) {
    throw new Error("logs/latest.log is not a file");
  }
  if (logStat.size === 0) {
    return "";
  }

  const start = Math.max(0, logStat.size - 128 * 1024);
  return (await readFileRange(logPath, start, logStat.size - 1)).toString("utf8");
}

function streamLatestServerLog(server: AttachedServer, client: Client) {
  const logPath = ensureInsideServer(server, "logs/latest.log");
  let offset = 0;
  let closed = false;

  const send = (text: string) => {
    if (text && client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", source: "latest.log", text, at: new Date().toISOString() }));
    }
  };

  const poll = async () => {
    if (closed) return;
    try {
      const logStat = await stat(logPath);
      if (!logStat.isFile()) {
        client.send(JSON.stringify({ type: "unavailable", message: "logs/latest.log is not a file" }));
        return;
      }

      if (logStat.size < offset) {
        offset = 0;
      }

      if (logStat.size > offset) {
        const start = offset === 0 ? Math.max(0, logStat.size - 128 * 1024) : offset;
        const chunk = await readFileRange(logPath, start, logStat.size - 1);
        offset = logStat.size;
        send(chunk.toString("utf8"));
      } else if (offset === 0) {
        offset = logStat.size;
        client.send(JSON.stringify({
          type: "log",
          source: "latest.log",
          text: "Watching logs/latest.log. The file is currently empty.",
          at: new Date().toISOString()
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read logs/latest.log";
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "unavailable", message }));
      }
    }
  };

  void poll();
  const interval = setInterval(() => void poll(), 1_000);
  return () => {
    closed = true;
    clearInterval(interval);
  };
}

function stripDockerLogHeaders(buffer: Buffer) {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    chunks.push(buffer.subarray(start, end));
    offset = end;
  }
  return chunks.length ? Buffer.concat(chunks) : buffer;
}

function streamDockerLogs(server: AttachedServer, client: Client) {
  if (!server.dockerContainer || !dockerAvailable()) {
    client.send(JSON.stringify({ type: "unavailable", message: "Docker logs are not configured for this server" }));
    return undefined;
  }

  const request = http.request(
    {
      socketPath: config.dockerSocket,
      path: `/containers/${encodeURIComponent(server.dockerContainer)}/logs?stdout=1&stderr=1&tail=200&follow=1`,
      method: "GET"
    },
    (response) => {
      if (response.statusCode !== 200) {
        client.send(JSON.stringify({ type: "unavailable", message: `Docker logs returned ${response.statusCode}` }));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        const text = stripDockerLogHeaders(chunk).toString("utf8");
        if (text && client.readyState === 1) {
          client.send(JSON.stringify({ type: "log", source: "docker", text, at: new Date().toISOString() }));
        }
      });
    }
  );
  request.on("error", (error) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "unavailable", message: error.message }));
    }
  });
  request.end();
  return request;
}

async function modrinthFetch(url: string) {
  if (!config.modrinthApiKey) {
    throw new Error("MODRINTH_API_KEY is not configured; Modrinth search and install are disabled");
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ServerSentinel/0.2.0 (attached Fabric server admin)",
      Authorization: config.modrinthApiKey
    }
  });
  if (!response.ok) {
    throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

const app = Fastify({ logger: true });
await app.register(websocket);

app.get("/api/app", async () => {
  const servers = await readServers();
  return {
    servers: servers.map(publicServer),
    modrinthApiConfigured: Boolean(config.modrinthApiKey),
    dockerSocketMounted: dockerAvailable()
  };
});

app.post<{
  Body: {
    displayName?: string;
    serverDir?: string;
    minecraftVersion?: string;
    serverJar?: string;
    dockerContainer?: string;
  };
}>("/api/servers", async (request) => {
  const displayName = request.body.displayName?.trim();
  const serverDir = request.body.serverDir?.trim();
  if (!displayName || !serverDir) {
    throw new Error("Display name and mounted server directory are required");
  }
  const resolvedServerDir = resolve(serverDir);
  const serverStat = await stat(resolvedServerDir);
  if (!serverStat.isDirectory()) {
    throw new Error("Mounted server directory must exist and be a directory");
  }

  const now = new Date().toISOString();
  const server: AttachedServer = {
    id: randomUUID(),
    displayName,
    serverDir: resolvedServerDir,
    minecraftVersion: request.body.minecraftVersion?.trim() || undefined,
    serverJar: request.body.serverJar?.trim() || undefined,
    dockerContainer: request.body.dockerContainer?.trim() || undefined,
    serverType: "fabric",
    createdAt: now,
    updatedAt: now
  };
  const servers = await readServers();
  servers.push(server);
  await writeServers(servers);
  return publicServer(server);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/status", async (request) => {
  const server = await getServer(request.params.id);
  const latestLogPath = ensureInsideServer(server, "logs/latest.log");
  return {
    server: publicServer(server),
    docker: await dockerStatus(server),
    fileLogsAvailable: existsSync(latestLogPath),
    controlAvailable: Boolean(server.dockerContainer && dockerAvailable()),
    commandInputAvailable: false,
    commandInputMessage: "Live stdin commands are not implemented for attached servers in this MVP"
  };
});

app.post<{ Params: { id: string } }>("/api/servers/:id/start", async (request) => {
  return dockerAction(await getServer(request.params.id), "start");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", async (request) => {
  return dockerAction(await getServer(request.params.id), "stop");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", async (request) => {
  return dockerAction(await getServer(request.params.id), "restart");
});

app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/servers/:id/command", async () => {
  throw new Error("Live stdin commands are not implemented for attached Docker containers in this MVP");
});

app.get("/ws/console", { websocket: true }, async (socket, request) => {
  const client = socket as unknown as Client;
  const url = new URL(request.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") ?? undefined;
  try {
    const server = await getServer(serverId);
    client.send(JSON.stringify({ type: "status", status: await dockerStatus(server) }));
    if (server.dockerContainer && dockerAvailable()) {
      const logRequest = streamDockerLogs(server, client);
      socket.on("close", () => logRequest?.destroy());
      return;
    }

    const stopFileLogs = streamLatestServerLog(server, client);
    socket.on("close", stopFileLogs);
  } catch (error) {
    client.send(JSON.stringify({ type: "unavailable", message: (error as Error).message }));
  }
});

app.get<{ Params: { id: string } }>("/api/servers/:id/logs", async (request) => {
  const server = await getServer(request.params.id);
  if (server.dockerContainer && dockerAvailable()) {
    return { text: await dockerRecentLogs(server), source: "docker" };
  }
  return { text: await readLatestServerLog(server), source: "logs/latest.log" };
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/files", async (request) => {
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.query.path ?? ".");
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await readdir(target, { withFileTypes: true });
  return {
    path: toPublicPath(server, target),
    entries: await Promise.all(
      entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(async (entry) => {
          const absolutePath = join(target, entry.name);
          const entryStat = await stat(absolutePath);
          return {
            name: entry.name,
            path: toPublicPath(server, absolutePath),
            type: entry.isDirectory() ? "directory" : "file",
            size: entryStat.size,
            modifiedAt: entryStat.mtime.toISOString()
          };
        })
    )
  };
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file", async (request) => {
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.query.path ?? "");
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  if (targetStat.size > 2 * 1024 * 1024) {
    throw new Error("File is larger than the 2 MiB editor limit");
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new Error("Binary files cannot be edited in the browser editor");
  }
  return {
    path: toPublicPath(server, target),
    content: buffer.toString("utf8"),
    modifiedAt: targetStat.mtime.toISOString()
  };
});

app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>("/api/servers/:id/file", async (request) => {
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.body.path ?? "");
  if (typeof request.body.content !== "string") {
    throw new Error("Content is required");
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  await writeFile(target, request.body.content, "utf8");
  return { ok: true, path: toPublicPath(server, target) };
});

app.get<{ Querystring: { query?: string; gameVersion?: string } }>("/api/modrinth/search", async (request) => {
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [] };
  }

  const facets = [["project_type:mod"], ["categories:fabric"]];
  if (request.query.gameVersion?.trim()) {
    facets.push([`versions:${request.query.gameVersion.trim()}`]);
  }

  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("facets", JSON.stringify(facets));
  const response = await modrinthFetch(url.toString());
  return response.json();
});

app.post<{ Body: { serverId?: string; projectId?: string; gameVersion?: string } }>("/api/modrinth/install", async (request) => {
  const server = await getServer(request.body.serverId);
  const projectId = request.body.projectId?.trim();
  const gameVersion = request.body.gameVersion?.trim();
  if (!projectId || !gameVersion) {
    throw new Error("projectId and gameVersion are required for compatible Fabric installs");
  }

  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([gameVersion]));
  const versionsResponse = await modrinthFetch(versionsUrl.toString());
  const versions = (await versionsResponse.json()) as Array<{
    version_number: string;
    files: Array<{ url: string; filename: string; primary: boolean }>;
  }>;
  const version = versions[0];
  const file = version?.files.find((candidate) => candidate.primary && candidate.filename.endsWith(".jar"))
    ?? version?.files.find((candidate) => candidate.filename.endsWith(".jar"));
  if (!version || !file) {
    throw new Error("No compatible Fabric .jar file was found for that Minecraft version");
  }
  if (!file.url.startsWith("https://")) {
    throw new Error("Refusing to download a non-HTTPS mod file");
  }

  const modsDir = ensureInsideServer(server, "mods");
  await mkdir(modsDir, { recursive: true });
  const destination = ensureInsideServer(server, join("mods", safeModFilename(file.filename)));
  const downloadResponse = await modrinthFetch(file.url);
  if (!downloadResponse.body) {
    throw new Error("Mod download returned no body");
  }
  await pipeline(
    Readable.fromWeb(downloadResponse.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(destination)
  );

  return {
    ok: true,
    projectId,
    version: version.version_number,
    filename: basename(destination),
    path: toPublicPath(server, destination)
  };
});

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/ws/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(400).send({ error: error instanceof Error ? error.message : "Request failed" });
});

await app.listen({ host: "0.0.0.0", port: config.port });
