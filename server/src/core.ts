import { basename, resolve, sep } from "node:path";

export type ServerPathScope = {
  serverDir: string;
};

export function ensureInsideServer(server: ServerPathScope, userPath = ".") {
  const serverDir = resolve(server.serverDir);
  const trimmed = userPath.replace(/^[/\\]+/, "");
  const target = resolve(serverDir, trimmed || ".");
  if (target !== serverDir && !target.startsWith(serverDir + sep)) {
    throw new Error("Path escapes the registered server directory");
  }
  return target;
}

export function safeModFilename(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_");
}

export function safeInstalledModFilename(name?: string) {
  const filename = basename(name ?? "").trim();
  if (!filename || filename !== name || (!filename.endsWith(".jar") && !filename.endsWith(".jar.disabled"))) {
    throw new Error("A valid mod filename is required");
  }
  return filename;
}

export function parseCronField(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/", 2);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-", 2).map(Number);
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
        start = rawStart;
        end = rawEnd;
      } else {
        const exact = Number(rangePart);
        if (!Number.isInteger(exact)) return null;
        start = exact;
        end = exact;
      }
    }

    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

export function validateCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must use five fields: minute hour day month weekday");
  }
  const valid = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7)
  ].every(Boolean);
  if (!valid) {
    throw new Error("Cron schedule contains an invalid field");
  }
}

export function cronMatches(cron: string, date: Date) {
  validateCron(cron);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  const normalizedDay = date.getDay();
  const days = parseCronField(dayOfWeek, 0, 7)!;
  return parseCronField(minute, 0, 59)!.has(date.getMinutes())
    && parseCronField(hour, 0, 23)!.has(date.getHours())
    && parseCronField(dayOfMonth, 1, 31)!.has(date.getDate())
    && parseCronField(month, 1, 12)!.has(date.getMonth() + 1)
    && (days.has(normalizedDay) || (normalizedDay === 0 && days.has(7)));
}

export function parseDockerPorts(ports?: string) {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const rawPort of ports?.split(",") ?? []) {
    const port = rawPort.trim();
    if (!port) continue;
    const [hostPort, containerPortWithProtocol] = port.includes(":") ? port.split(":", 2) : [port, port];
    const containerPort = containerPortWithProtocol.includes("/")
      ? containerPortWithProtocol
      : `${containerPortWithProtocol}/tcp`;
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [{ HostPort: hostPort }];
  }
  return { exposedPorts, portBindings };
}
