import type { StageExecution, Task, UsageTotals } from "./api";

export function fmtDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

export function fmtUsage(usage: UsageTotals): string {
  const total = usage.inputTokens + usage.outputTokens;
  let text =
    `${usage.turns} turns · 合计 ${total} tokens · in ${usage.inputTokens} / out ${usage.outputTokens}`;
  if (usage.costUsd != null) text += ` · $${usage.costUsd.toFixed(4)}`;
  return text;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtClock(iso: string | undefined): string {
  return iso ? iso.slice(11, 19) : "—";
}

export function stageLabelClass(status: string): string {
  switch (status) {
    case "completed":
      return "Label--success";
    case "failed":
    case "aborted":
      return "Label--danger";
    case "waiting":
      return "Label--attention";
    case "pending":
      return "";
    default:
      return "Label--accent";
  }
}

export function stateClass(status: Task["status"]): string {
  switch (status) {
    case "running":
    case "delivering":
      return "State--running";
    case "waiting_human":
    case "paused":
      return "State--waiting";
    case "done":
    case "merged":
      return "State--done";
    case "failed":
    case "cancelled":
      return "State--failed";
    default:
      return "State--queued";
  }
}

export function outcomeSummary(outcome: Record<string, unknown> | undefined): string {
  if (!outcome) return "";
  const parts: string[] = [];
  const push = (cond: boolean, text: string) => {
    if (cond) parts.push(text);
  };
  push(outcome.passed != null, `passed=${String(outcome.passed)}`);
  push(outcome.commentCount != null, `comments=${String(outcome.commentCount)}`);
  push(outcome.approved != null, `approved=${String(outcome.approved)}`);
  push(outcome.rejected === true, "rejected");
  push(outcome.skipped === true, "skipped");
  push(typeof outcome.sha === "string", `sha=${String(outcome.sha).slice(0, 8)}`);
  if (Array.isArray(outcome.filesChanged)) parts.push(`files=${outcome.filesChanged.length}`);
  if (Array.isArray(outcome.failures) && outcome.failures.length) {
    parts.push(`failures=${outcome.failures.length}`);
  }
  if (typeof outcome.summary === "string" && outcome.summary) parts.push(outcome.summary);
  return parts.join(" · ");
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function stageToneClass(status: StageExecution["status"] | "pending"): string {
  if (status === "failed" || status === "aborted") return "workflow-node--failed";
  if (status === "waiting") return "workflow-node--waiting";
  if (status === "running") return "workflow-node--running";
  if (status === "pending") return "workflow-node--pending";
  return "";
}
