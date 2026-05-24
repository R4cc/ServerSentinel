import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type AttachedServer = {
  id: string;
  displayName: string;
  directoryLabel: string;
  minecraftVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  serverType: "fabric";
  hasDockerContainer: boolean;
};

type AppState = {
  servers: AttachedServer[];
  modrinthApiConfigured: boolean;
  dockerSocketMounted: boolean;
};

type DockerStatus = {
  configured: boolean;
  available: boolean;
  controllable: boolean;
  state: string;
  running?: boolean;
  container?: string;
  message?: string;
};

type ServerStatus = {
  server: AttachedServer;
  docker: DockerStatus;
  fileLogsAvailable: boolean;
  controlAvailable: boolean;
  commandInputAvailable: boolean;
  commandInputMessage: string;
};

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
};

type FileListing = {
  path: string;
  entries: FileEntry[];
};

type ModrinthHit = {
  project_id: string;
  title: string;
  description: string;
  downloads: number;
  icon_url?: string;
};

const emptyApp: AppState = {
  servers: [],
  modrinthApiConfigured: false,
  dockerSocketMounted: false
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
    ...init
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return payload as T;
}

function parentPath(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("1.21.4");
  const [mods, setMods] = useState<ModrinthHit[]>([]);
  const [notice, setNotice] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);

  const activeServer = useMemo(
    () => appState.servers.find((server) => server.id === activeServerId) ?? appState.servers[0],
    [activeServerId, appState.servers]
  );

  useEffect(() => {
    refreshApp();
  }, []);

  useEffect(() => {
    if (!activeServer) return;
    setActiveServerId(activeServer.id);
    setLogs([]);
    setSelectedPath("");
    setEditorText("");
    setDirty(false);
    refreshStatus(activeServer.id);
    loadFiles(activeServer.id, "/");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(activeServer.id)}`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-499), `[${message.source}] ${message.text}`]);
      }
      if (message.type === "unavailable") {
        setLogs([message.message]);
      }
    };
    socket.onerror = () => setLogs(["Console stream is unavailable."]);
    return () => socket.close();
  }, [activeServer?.id]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [logs]);

  async function refreshApp() {
    setNotice("");
    try {
      const next = await api<AppState>("/api/app");
      setAppState(next);
      if (!activeServerId && next.servers[0]) {
        setActiveServerId(next.servers[0].id);
      }
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function refreshStatus(serverId = activeServer?.id) {
    if (!serverId) return;
    try {
      setStatus(await api<ServerStatus>(`/api/servers/${serverId}/status`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function attachServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const server = await api<AttachedServer>("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          serverDir: form.get("serverDir"),
          minecraftVersion: form.get("minecraftVersion"),
          serverJar: form.get("serverJar"),
          dockerContainer: form.get("dockerContainer")
        })
      });
      await refreshApp();
      setActiveServerId(server.id);
      setNotice(`Attached ${server.displayName}`);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function runContainerAction(action: "start" | "stop" | "restart") {
    if (!activeServer) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshStatus(activeServer.id);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    setNotice(status?.commandInputMessage ?? "Live stdin commands are not implemented for attached servers in this MVP");
  }

  async function loadFiles(serverId: string, path: string) {
    setNotice("");
    try {
      setListing(await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function openFile(path: string) {
    if (!activeServer) return;
    setNotice("");
    try {
      const file = await api<{ path: string; content: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      setSelectedPath(file.path);
      setEditorText(file.content);
      setDirty(false);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function saveFile() {
    if (!activeServer) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: selectedPath, content: editorText })
      });
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      await loadFiles(activeServer.id, listing.path);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function searchMods(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    try {
      const result = await api<{ hits: ModrinthHit[] }>(
        `/api/modrinth/search?query=${encodeURIComponent(query)}&gameVersion=${encodeURIComponent(gameVersion)}`
      );
      setMods(result.hits);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function installMod(projectId: string, title: string) {
    if (!activeServer) return;
    setNotice("");
    try {
      const result = await api<{ filename: string; version: string }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId, gameVersion })
      });
      setNotice(`Installed ${title} ${result.version} as ${result.filename}`);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  if (!appState.servers.length) {
    return (
      <main className="shell">
        <header className="topbar">
          <div>
            <h1>ServerSentinel</h1>
            <p>Attach an existing Fabric server to begin.</p>
          </div>
          <div className="pill stopped">No servers registered</div>
        </header>
        {notice && <div className="notice">{notice}</div>}
        <section className="panel attachPanel">
          <h2>Attach existing Fabric server</h2>
          <AttachForm onSubmit={attachServer} dockerSocketMounted={appState.dockerSocketMounted} />
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>ServerSentinel</h1>
          <p>Attached Fabric server manager</p>
        </div>
        <div className={`pill ${status?.docker.running ? "running" : "stopped"}`}>
          {status?.docker.configured ? `Container ${status.docker.state}` : "File access only"}
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <section className="serverBar">
        <label>
          Active server
          <select value={activeServer?.id ?? ""} onChange={(event) => setActiveServerId(event.target.value)}>
            {appState.servers.map((server) => (
              <option key={server.id} value={server.id}>{server.displayName}</option>
            ))}
          </select>
        </label>
        <button onClick={() => refreshStatus()}>Refresh status</button>
      </section>

      <section className="grid">
        <section className="panel controls">
          <h2>Attached Server</h2>
          <dl className="meta">
            <dt>Directory</dt>
            <dd>{activeServer?.directoryLabel}</dd>
            <dt>Version</dt>
            <dd>{activeServer?.minecraftVersion || "Manual / unknown"}</dd>
            <dt>Docker</dt>
            <dd>{status?.docker.message || status?.docker.container || "Not configured"}</dd>
          </dl>
          <div className="buttonRow">
            <button onClick={() => runContainerAction("start")} disabled={!status?.controlAvailable || status.docker.running}>Start</button>
            <button onClick={() => runContainerAction("stop")} disabled={!status?.controlAvailable || !status.docker.running}>Stop</button>
            <button onClick={() => runContainerAction("restart")} disabled={!status?.controlAvailable}>Restart</button>
          </div>
          <form onSubmit={sendCommand} className="commandLine">
            <input placeholder="Live stdin commands are unavailable in this MVP" disabled />
            <button disabled>Send</button>
          </form>
          <p className="muted">{status?.commandInputMessage}</p>
        </section>

        <section className="panel consolePanel">
          <h2>Console Logs</h2>
          <div className="console" ref={consoleRef}>
            {logs.length ? logs.map((line, index) => <pre key={index}>{line}</pre>) : <span className="muted">Waiting for logs/latest.log output.</span>}
          </div>
          <p className="muted">
            {status?.docker.configured && appState.dockerSocketMounted
              ? "Streaming Docker container logs."
              : "Streaming the attached server file logs/latest.log. ServerSentinel is not running Minecraft."}
          </p>
        </section>

        <section className="panel filesPanel">
          <div className="panelHeader">
            <h2>Files</h2>
            <code>{listing.path}</code>
          </div>
          <div className="fileActions">
            <button onClick={() => activeServer && loadFiles(activeServer.id, parentPath(listing.path))} disabled={listing.path === "/"}>Up</button>
            <button onClick={() => activeServer && loadFiles(activeServer.id, listing.path)}>Refresh</button>
          </div>
          <div className="fileList">
            {listing.entries.map((entry) => (
              <button key={entry.path} className="fileRow" onClick={() => entry.type === "directory" ? activeServer && loadFiles(activeServer.id, entry.path) : openFile(entry.path)}>
                <span>{entry.type === "directory" ? "[dir]" : "[file]"} {entry.name}</span>
                <small>{entry.type === "file" ? formatBytes(entry.size) : ""}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel editorPanel">
          <div className="panelHeader">
            <h2>Editor</h2>
            <code>{selectedPath || "No file selected"}</code>
          </div>
          <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={!selectedPath} spellCheck={false} />
          <div className="buttonRow">
            <button onClick={saveFile} disabled={!selectedPath || !dirty}>Save</button>
            <span className="muted">Text files up to 2 MiB are supported. Binary editing is intentionally blocked.</span>
          </div>
        </section>

        <section className="panel modsPanel">
          <div className="panelHeader">
            <h2>Modrinth</h2>
            <span className={appState.modrinthApiConfigured ? "ok" : "muted"}>
              API key {appState.modrinthApiConfigured ? "configured" : "not configured"}
            </span>
          </div>
          <form onSubmit={searchMods} className="modSearch">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Fabric mods" />
            <input value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} placeholder="Minecraft version" />
            <button disabled={!query.trim() || !gameVersion.trim()}>Search</button>
          </form>
          <div className="mods">
            {mods.map((mod) => (
              <article key={mod.project_id} className="modRow">
                {mod.icon_url && <img src={mod.icon_url} alt="" />}
                <div>
                  <strong>{mod.title}</strong>
                  <p>{mod.description}</p>
                  <small>{mod.downloads.toLocaleString()} downloads</small>
                </div>
                <button onClick={() => installMod(mod.project_id, mod.title)}>Install</button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel settingsPanel">
          <h2>Settings</h2>
          <dl className="meta">
            <dt>Server type</dt>
            <dd>Fabric</dd>
            <dt>Jar metadata</dt>
            <dd>{activeServer?.serverJar || "Not set"}</dd>
            <dt>Docker socket</dt>
            <dd>{appState.dockerSocketMounted ? "Mounted" : "Not mounted"}</dd>
            <dt>File logs</dt>
            <dd>{status?.fileLogsAvailable ? "logs/latest.log found" : "logs/latest.log not found"}</dd>
            <dt>Control</dt>
            <dd>{status?.controlAvailable ? "Docker container control enabled" : "Not configured"}</dd>
          </dl>
        </section>
      </section>
    </main>
  );
}

function AttachForm({
  onSubmit,
  dockerSocketMounted
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dockerSocketMounted: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="attachForm">
      <label>
        Display name
        <input name="displayName" placeholder="Survival" required />
      </label>
      <label>
        Mounted server directory
        <input name="serverDir" placeholder="/data/servers/survival" required />
      </label>
      <label>
        Minecraft version
        <input name="minecraftVersion" placeholder="1.21.4" />
      </label>
      <label>
        Server jar filename
        <input name="serverJar" placeholder="server.jar" />
      </label>
      <label>
        Docker container name/id
        <input name="dockerContainer" placeholder="minecraft" />
      </label>
      <p className="muted">
        Docker socket is {dockerSocketMounted ? "mounted; container status/control can be enabled." : "not mounted; files and mods still work."}
      </p>
      <button>Attach Server</button>
    </form>
  );
}
