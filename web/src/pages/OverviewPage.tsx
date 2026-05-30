import { useEffect, useMemo, useState } from 'react';
import type { ManagedServer, ServerActivity, ServerEvent, ServerStatus } from '../types';
import { formatActivityDate, formatUptime } from '../components/ResourcePanel';
import { fabricLoaderVersionInfo, minecraftVersionInfo, runtimeLabel, runtimeTone, versionSourceLabel, versionValue } from '../utils/format';

const hiddenRecentEventsKey = 'serversentinel-hidden-recent-event-signatures';

function dockerStateLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!dockerSocketMounted) return "Unavailable";
  if (!status) return "Unknown";
  if (!status.docker.configured) return "Unconfigured";
  if (!status.docker.available) return "Unavailable";
  if (status.docker.running) return "Running";
  if (status.docker.state === "created") return "Created";
  if (status.docker.state === "restarting") return "Restarting";
  if (status.docker.state === "paused") return "Paused";
  if (status.docker.state === "dead") return "Crashed";
  if (status.docker.state === "exited") return "Stopped";
  if (status.docker.state === "removing") return "Stopping";
  return "Unknown";
}

function summaryTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!dockerSocketMounted || !status || !status.docker.available || !status.docker.configured) return "neutral";
  if (status.docker.running) return "running";
  if (status.docker.state === "dead") return "danger";
  return "stopped";
}

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  formatDate
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  formatDate: (value: string | number | Date) => string;
}) {
  const running = Boolean(status?.docker.running);
  const state = dockerStateLabel(status, dockerSocketMounted);
  const players = activity.playersOnline === null || activity.playersOnline === undefined
    ? "Unknown"
    : activity.maxPlayers
      ? `${activity.playersOnline} / ${activity.maxPlayers}`
      : String(activity.playersOnline);
  const minecraftVersion = minecraftVersionInfo(server);
  const fabricLoaderVersion = fabricLoaderVersionInfo(server);
  return (
    <section className="overviewSummary">
      <div className={`summaryTile state ${summaryTone(status, dockerSocketMounted)}`}>
        <span>State</span>
        <strong>{state}</strong>
        <small>{running ? `Since ${formatActivityDate(activity.lastStartedAt, formatDate)}` : status?.docker.message || "Not running"}</small>
      </div>
      <div className="summaryTile">
        <span>Minecraft version</span>
        <strong>{versionValue(minecraftVersion)}</strong>
        <small>{versionSourceLabel(minecraftVersion.source)}</small>
      </div>
      <div className="summaryTile">
        <span>Fabric loader</span>
        <strong>{versionValue(fabricLoaderVersion)}</strong>
        <small>{versionSourceLabel(fabricLoaderVersion.source)}</small>
      </div>
      <div className="summaryTile">
        <span>Uptime</span>
        <strong>{running ? formatUptime(activity.lastStartedAt, running) : "Not running"}</strong>
        <small>{running ? "Container start time" : "Unavailable while stopped"}</small>
      </div>
      <div className="summaryTile">
        <span>Players online</span>
        <strong>{players}</strong>
        <small>{players === "Unknown" ? "Player count unavailable" : activity.maxPlayers ? "Max players" : "From recent server output"}</small>
      </div>
      <div className={`summaryTile ${runtimeTone(status, dockerSocketMounted)}`}>
        <span>Runtime status</span>
        <strong>{runtimeLabel(status, dockerSocketMounted).replace(/^Container /, "")}</strong>
        <small>{status?.docker.container || "Container unavailable"}</small>
      </div>
    </section>
  );
}

export function ActivityHealthPanel({ activity, formatDate }: { activity: ServerActivity; formatDate: (value: string | number | Date) => string }) {
  const items = [
    ["Last started", formatActivityDate(activity.lastStartedAt, formatDate)],
    ["Last restart", formatActivityDate(activity.lastRestartAt, formatDate)],
    ["Last stopped", formatActivityDate(activity.lastStoppedAt, formatDate)],
    ["Current world", activity.currentWorld || "Unknown"],
    ["Server port", activity.serverPort || "Unknown"],
    ["EULA accepted", activity.eulaAccepted === undefined ? "Unknown" : activity.eulaAccepted ? "Yes" : "No"],
    ["Java", activity.javaRuntime || "Unknown"],
    ["Autosave", activity.autosaveStatus || "Unavailable"]
  ];
  return (
    <section className="panel activityPanel">
      <div className="panelHeader">
        <h2>Server Activity &amp; Health</h2>
      </div>
      <div className="activityGrid">
        {items.map(([label, value]) => (
          <div className="activityItem" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatEventTimestamp(value: string | undefined, formatDate: (value: string | number | Date) => string) {
  if (!value) return "No timestamp";
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
                  date.getMonth() === now.getMonth() &&
                  date.getDate() === now.getDate();

  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const timeStr = `${hours}:${minutes}`;

  if (isToday) {
    return `Today, ${timeStr}`;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];
  const day = date.getDate();
  return `${month} ${day}, ${timeStr}`;
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  formatDate,
  onOpenConsole
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  formatDate: (value: string | number | Date) => string;
  onOpenConsole: () => void;
}) {
  const [hiddenSignatures, setHiddenSignatures] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(hiddenRecentEventsKey);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const hiddenSignatureSet = useMemo(() => new Set(hiddenSignatures), [hiddenSignatures]);
  const visibleEvents = useMemo(
    () => events.filter((event) => !hiddenSignatureSet.has(event.signature)),
    [events, hiddenSignatureSet]
  );
  const displayEvents = visibleEvents.slice(0, 8);
  const hasHiddenEvents = events.some((event) => hiddenSignatureSet.has(event.signature));

  useEffect(() => {
    window.localStorage.setItem(hiddenRecentEventsKey, JSON.stringify(hiddenSignatures));
  }, [hiddenSignatures]);

  function hideEvent(signature: string) {
    setHiddenSignatures((current) => current.includes(signature) ? current : [...current, signature]);
  }

  return (
    <section className="panel eventsPanel">
      <div className="panelHeader">
        <h2>Recent Events</h2>
        {hiddenSignatures.length > 0 && (
          <button type="button" className="textLinkButton compact" onClick={() => setHiddenSignatures([])}>
            Reset hidden events
          </button>
        )}
      </div>
      <div className="eventList">
        {displayEvents.length ? displayEvents.map((event) => (
          <div className={`eventRow ${event.type}`} key={event.id}>
            <span className="eventMarker" aria-hidden="true" />
            <strong>{event.text}</strong>
            <small>{formatEventTimestamp(event.timestamp, formatDate)}</small>
            <button type="button" className="eventHideButton" onClick={() => hideEvent(event.signature)}>
              Hide
            </button>
          </div>
        )) : (
          <div className="eventEmpty">
            {hasHiddenEvents ? "All recent matching events are hidden." : eventsStatus === "unavailable" ? "Logs unavailable." : "No recent server events found."}
          </div>
        )}
      </div>
      <button type="button" className="textLinkButton" onClick={onOpenConsole}>View full log</button>
    </section>
  );
}
