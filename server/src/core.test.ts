import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  cronMatches,
  ensureInsideServer,
  parseDockerPorts,
  safeInstalledModFilename,
  validateCron
} from "./core.js";

const server = { serverDir: resolve("test-fixtures/server") };

describe("path safety", () => {
  it("accepts normal relative paths", () => {
    expect(ensureInsideServer(server, "mods/fabric-api.jar")).toBe(resolve(server.serverDir, "mods/fabric-api.jar"));
  });

  it("rejects parent directory traversal", () => {
    expect(() => ensureInsideServer(server, "../outside.txt")).toThrow("Path escapes");
  });

  it("rejects native absolute path escapes", () => {
    expect(() => ensureInsideServer(server, resolve(server.serverDir, "..", "outside.txt"))).toThrow("Path escapes");
  });
});

describe("cron parsing and matching", () => {
  it("accepts valid five-field cron", () => {
    expect(() => validateCron("30 4 * * 1-5")).not.toThrow();
  });

  it("rejects invalid cron fields", () => {
    expect(() => validateCron("61 4 * * *")).toThrow("invalid field");
    expect(() => validateCron("0 24 * * *")).toThrow("invalid field");
    expect(() => validateCron("0 4 *")).toThrow("five fields");
  });

  it("matches expected dates", () => {
    expect(cronMatches("30 4 * * 1-5", new Date(2026, 4, 26, 4, 30))).toBe(true);
    expect(cronMatches("30 4 * * 1-5", new Date(2026, 4, 26, 4, 31))).toBe(false);
    expect(cronMatches("0 12 26 5 2", new Date(2026, 4, 26, 12, 0))).toBe(true);
  });
});

describe("Docker port parsing", () => {
  it("maps a bare port to the same host and container port", () => {
    expect(parseDockerPorts("25565")).toEqual({
      exposedPorts: { "25565/tcp": {} },
      portBindings: { "25565/tcp": [{ HostPort: "25565" }] }
    });
  });

  it("maps an explicit host, container, and protocol binding", () => {
    expect(parseDockerPorts("25565:25565/tcp")).toEqual({
      exposedPorts: { "25565/tcp": {} },
      portBindings: { "25565/tcp": [{ HostPort: "25565" }] }
    });
  });

  it("maps multiple comma-separated ports", () => {
    expect(parseDockerPorts("25565:25565/tcp, 24454:24454/udp")).toEqual({
      exposedPorts: { "25565/tcp": {}, "24454/udp": {} },
      portBindings: {
        "25565/tcp": [{ HostPort: "25565" }],
        "24454/udp": [{ HostPort: "24454" }]
      }
    });
  });
});

describe("mod filename safety", () => {
  it("accepts valid jar filenames", () => {
    expect(safeInstalledModFilename("fabric-api.jar")).toBe("fabric-api.jar");
  });

  it("accepts disabled jar filenames", () => {
    expect(safeInstalledModFilename("fabric-api.jar.disabled")).toBe("fabric-api.jar.disabled");
  });

  it("rejects path-like filenames", () => {
    expect(() => safeInstalledModFilename("../fabric-api.jar")).toThrow("valid mod filename");
    expect(() => safeInstalledModFilename("mods/fabric-api.jar")).toThrow("valid mod filename");
  });

  it("rejects non-jar filenames", () => {
    expect(() => safeInstalledModFilename("fabric-api.zip")).toThrow("valid mod filename");
    expect(() => safeInstalledModFilename("fabric-api.jar.bak")).toThrow("valid mod filename");
  });
});
