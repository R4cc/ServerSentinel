import { modrinthFetch } from "./modrinthClient.js";
import type { ModCompatibility, ModrinthVersion, ReleaseChannel } from "../types.js";

const channelRank: Record<ReleaseChannel, number> = { release: 0, beta: 1, alpha: 2 };

export type ModrinthJarFile = {
  url: string;
  filename: string;
  primary: boolean;
  size?: number;
  hashes?: Record<string, string>;
};

export type ModrinthCompatibilityMatch = ModCompatibility & {
  matchedVersionId?: string;
  matchedVersionNumber?: string;
  matchedVersionType?: ReleaseChannel;
  matchedLoaders?: string[];
  matchedGameVersions?: string[];
  file?: ModrinthJarFile;
};

export type CompatibilityResolverOptions = {
  projectId: string;
  minecraftVersion: string;
  loader: string;
  channel: ReleaseChannel;
};

export type VersionCompatibilityOptions = Omit<CompatibilityResolverOptions, "projectId">;

type CachedVersions = {
  filtered?: ModrinthVersion[];
  all?: ModrinthVersion[];
};

const versionCache = new Map<string, CachedVersions>();

export function normalizeReleaseChannel(channel?: string): ReleaseChannel {
  return channel === "alpha" || channel === "beta" ? channel : "release";
}

export function versionChannel(versionType?: string): ReleaseChannel {
  return normalizeReleaseChannel(versionType);
}

export function allowedForChannel(version: ModrinthVersion, selectedChannel: ReleaseChannel) {
  return channelRank[versionChannel(version.version_type)] <= channelRank[selectedChannel];
}

export function modrinthJarFile(version?: ModrinthVersion): ModrinthJarFile | undefined {
  return version?.files.find((candidate) => candidate.primary && candidate.filename.endsWith(".jar"))
    ?? version?.files.find((candidate) => candidate.filename.endsWith(".jar"));
}

function compatibleResult(version: ModrinthVersion, file: ModrinthJarFile): ModrinthCompatibilityMatch {
  return {
    status: "compatible",
    compatible: true,
    reason: "Compatible with this server",
    matchedVersionId: version.id,
    matchedVersionNumber: version.version_number,
    matchedVersionType: versionChannel(version.version_type),
    matchedLoaders: version.loaders,
    matchedGameVersions: version.game_versions,
    file
  };
}

function incompatible(status: ModCompatibility["status"], reason: string, fallbackVersion?: ModrinthVersion): ModrinthCompatibilityMatch {
  const file = modrinthJarFile(fallbackVersion);
  return {
    status,
    compatible: false,
    reason,
    matchedVersionId: fallbackVersion?.id,
    matchedVersionNumber: fallbackVersion?.version_number,
    matchedVersionType: fallbackVersion ? versionChannel(fallbackVersion.version_type) : undefined,
    matchedLoaders: fallbackVersion?.loaders,
    matchedGameVersions: fallbackVersion?.game_versions,
    file
  };
}

export function unknownCompatibility(): ModrinthCompatibilityMatch {
  return {
    status: "unknown",
    compatible: false,
    reason: "Compatibility could not be verified."
  };
}

export function resolveCompatibilityFromVersions(versions: ModrinthVersion[], options: VersionCompatibilityOptions): ModrinthCompatibilityMatch {
  const loaderVersions = versions.filter((version) => version.loaders.includes(options.loader));
  const loaderAndGameVersions = loaderVersions.filter((version) => version.game_versions.includes(options.minecraftVersion));
  const loaderGameJarVersions = loaderAndGameVersions.filter((version) => modrinthJarFile(version));
  const matchingVersion = loaderGameJarVersions.find((version) => allowedForChannel(version, options.channel));
  const matchingFile = modrinthJarFile(matchingVersion);

  if (matchingVersion && matchingFile) {
    return compatibleResult(matchingVersion, matchingFile);
  }

  const fallbackVersion = loaderGameJarVersions[0]
    ?? loaderAndGameVersions[0]
    ?? loaderVersions[0]
    ?? versions.find((version) => version.game_versions.includes(options.minecraftVersion) && modrinthJarFile(version))
    ?? versions.find((version) => modrinthJarFile(version));

  if (loaderVersions.length === 0) {
    return incompatible("no_fabric", "No Fabric version available", fallbackVersion);
  }
  if (loaderAndGameVersions.length === 0) {
    return incompatible("no_minecraft_version", `Not available for Minecraft ${options.minecraftVersion}`, fallbackVersion);
  }
  if (loaderGameJarVersions.length === 0) {
    return incompatible("incompatible", "No installable .jar file was found", fallbackVersion);
  }
  return incompatible("incompatible", "No version matched the selected release channel", fallbackVersion);
}

async function fetchProjectVersions(projectId: string, filters?: { loader?: string; minecraftVersion?: string }) {
  const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set("include_changelog", "false");
  if (filters?.loader) {
    url.searchParams.set("loaders", JSON.stringify([filters.loader]));
  }
  if (filters?.minecraftVersion) {
    url.searchParams.set("game_versions", JSON.stringify([filters.minecraftVersion]));
  }
  const response = await modrinthFetch(url.toString());
  return await response.json() as ModrinthVersion[];
}

export async function resolveModrinthProjectCompatibility(options: CompatibilityResolverOptions): Promise<ModrinthCompatibilityMatch> {
  const cacheKey = `${options.projectId}|${options.minecraftVersion}|${options.loader}|${options.channel}`;
  const cached = versionCache.get(cacheKey) ?? {};
  versionCache.set(cacheKey, cached);

  try {
    cached.filtered ??= await fetchProjectVersions(options.projectId, {
      loader: options.loader,
      minecraftVersion: options.minecraftVersion
    });
    const filteredResult = resolveCompatibilityFromVersions(cached.filtered, options);
    if (filteredResult.compatible) {
      return filteredResult;
    }

    cached.all ??= await fetchProjectVersions(options.projectId);
    return resolveCompatibilityFromVersions(cached.all, options);
  } catch {
    return unknownCompatibility();
  }
}
