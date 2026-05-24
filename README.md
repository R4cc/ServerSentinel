# ServerSentinel

ServerSentinel is a Dockerized, single-user WebUI for attaching to existing Fabric Minecraft servers.

It does not create Minecraft servers, install Fabric, or run `java -jar`. Minecraft runs separately, usually in its own Docker container. ServerSentinel attaches to the server files through a mounted volume and can optionally observe/control the Minecraft container through the Docker socket.

This MVP intentionally has no authentication, no multi-user model, and no database.

## What Works

Without Docker socket access:

- Register an existing Fabric server directory mounted into the ServerSentinel container.
- Browse files inside the registered server directory.
- View and edit UTF-8 text files in the browser.
- Read and stream the attached server's `logs/latest.log` file.
- Search Modrinth using a server-side `MODRINTH_API_KEY`.
- Install compatible Fabric `.jar` files into the registered server's `mods` directory.

With Docker socket access and a configured container name/id:

- Read Minecraft container status.
- Start, stop, and restart the configured Minecraft container.
- Read recent container logs instead of file logs.
- Stream container logs to the console panel instead of `logs/latest.log`.

Live stdin command input is not implemented in this MVP. The UI shows this explicitly instead of pretending command sending works.

## Safety Boundaries

- Registered servers are persisted in ServerSentinel config storage at `SERVERSENTINEL_CONFIG_DIR`.
- File operations are scoped to the active registered server directory.
- Requests that try to escape the registered server directory are rejected.
- Mod downloads only write beneath the active server's `mods` folder.
- Browser editing rejects binary files and files larger than 2 MiB.
- `MODRINTH_API_KEY` is read only by the backend and is never sent to the frontend.
- ServerSentinel does not require Java and does not execute Minecraft.

## Environment

Copy `.env.example` to `.env` and adjust values as needed:

```env
SERVERSENTINEL_CONFIG_DIR=/config
MODRINTH_API_KEY=
PORT=8080
MINECRAFT_VERSION=1.21.4
MINECRAFT_MEMORY=4G
```

The Compose example mounts a shared `minecraft-server` volume into:

- the Minecraft container at `/data`
- ServerSentinel at `/data/servers/survival`

When first opening ServerSentinel, attach that server with:

- Display name: `Survival`
- Mounted server directory: `/data/servers/survival`
- Minecraft version: your version, for example `1.21.4`
- Server jar filename: optional metadata only
- Docker container name/id: `minecraft` if Docker socket integration is enabled

## Docker Socket Security

Mounting `/var/run/docker.sock` gives ServerSentinel powerful control over Docker on the host. Treat it as trusted-admin access. Only enable it in local or otherwise trusted environments.

If the socket is not mounted, ServerSentinel still works for files, editing, Modrinth installs, and `logs/latest.log` viewing. Container status and start/stop/restart require the socket or a future control mechanism.

## Docker

Build and run:

```bash
docker compose up --build
```

Open `http://localhost:8080`.

## Docker Hub Publishing

The GitHub Actions workflow in `.github/workflows/dockerpush.yml` builds and pushes `nl2109/serversentinel` when changes land on `main`.

Configure these GitHub repository secrets before pushing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Pull the published image with:

```bash
docker pull nl2109/serversentinel:latest
```

To enable Docker container status/control/logs, uncomment this volume in `docker-compose.yml`:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
```

## Development

Install dependencies:

```bash
npm install
```

Run the backend and frontend in separate terminals:

```bash
npm run dev:server
npm run dev:web
```

For local development outside Docker, set `SERVERSENTINEL_CONFIG_DIR` to a writable local folder and register a server directory that exists on your machine.

The Vite dev server proxies `/api` and `/ws` to the backend on port `8080`.

Build everything:

```bash
npm run build
```

## Current MVP Limitations

- No authentication. Do not expose this service directly to the public internet.
- No server creation or Fabric installation workflow.
- No live stdin command bridge for attached Docker containers.
- No mod dependency/conflict resolver; installs the latest Modrinth version matching Fabric and the requested Minecraft version.
- No deletion flow for registered servers yet; edit the JSON config in `SERVERSENTINEL_CONFIG_DIR/servers.json` if needed.
