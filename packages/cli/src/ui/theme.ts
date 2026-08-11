import type { NodePrimitive } from "@devtools/shared";
import type { TaskUiStatus } from "./reducer.js";

export const icons = {
  nodeStart: "▶",
  nodeDone: "✓",
  tool: "⚙",
  file: "✎",
  commit: "●",
  review: "◆",
  artifact: "⤓",
  gate: "⏸",
  resolved: "✔",
  inject: "↳",
  retry: "↻",
  loop: "↺",
  warn: "!",
  error: "✗",
  info: "·",
  usage: "∑",
} as const;

export const colors = {
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  err: "red",
  muted: "gray",
  info: "blue",
} as const;

const primitiveColors: Record<NodePrimitive, string> = {
  agent: "cyan",
  review: "magenta",
  gate: "yellow",
  command: "blue",
  verify: "blue",
  commit: "green",
};

export function primitiveColor(primitive: string): string {
  return primitiveColors[primitive as NodePrimitive] ?? colors.accent;
}

export function statusColor(status: TaskUiStatus): string {
  switch (status) {
    case "running":
      return colors.accent;
    case "suspended":
      return colors.warn;
    case "completed":
      return colors.ok;
    case "failed":
    case "aborted":
      return colors.err;
    default:
      return colors.muted;
  }
}

export function severityColor(severity: string): string {
  switch (severity) {
    case "blocker":
      return colors.err;
    case "major":
      return colors.warn;
    default:
      return colors.muted;
  }
}

export function logLevelColor(level: string): string {
  switch (level) {
    case "error":
      return colors.err;
    case "warn":
      return colors.warn;
    default:
      return colors.muted;
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Collapse whitespace and clip so a single log line never wraps into a wall of text. */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function shortId(id: string | undefined, len = 8): string {
  if (!id) return "-";
  return id.length <= len ? id : id.slice(0, len);
}
