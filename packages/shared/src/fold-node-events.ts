import type { EngineChunkPayload, KernelEvent } from "./events.js";
import type { EngineChunk } from "./types.js";

export type NodeStreamItem =
  | { kind: "text"; text: string; ts: string }
  | { kind: "thinking"; text: string; ts: string }
  | { kind: "tool"; tool: string; summary: string; ts: string }
  | { kind: "file"; path: string; op: string; ts: string }
  | { kind: "meta"; label: string; detail: string; ts: string; tone?: "ok" | "bad" | "warn" };

const SKIP = new Set<string>(["node.started", "node.completed", "task.started", "task.resumed"]);

/** Collapse a node's event range into a readable stream (chunks merged). */
export function foldNodeEventStream(events: KernelEvent[]): NodeStreamItem[] {
  const items: NodeStreamItem[] = [];
  for (const event of events) {
    if (SKIP.has(event.type)) continue;
    if (event.type === "engine.chunk") {
      appendChunk(items, event.ts, (event.payload as EngineChunkPayload).chunk);
      continue;
    }
    const meta = summarizeMeta(event);
    if (meta) items.push({ kind: "meta", ts: event.ts, ...meta });
  }
  return items;
}

function appendChunk(items: NodeStreamItem[], ts: string, chunk: EngineChunk | undefined): void {
  if (!chunk) return;
  if (chunk.kind === "text" || chunk.kind === "thinking") {
    const last = items[items.length - 1];
    if (last && last.kind === chunk.kind) {
      last.text += chunk.text ?? "";
      return;
    }
    items.push({ kind: chunk.kind, text: chunk.text ?? "", ts });
    return;
  }
  if (chunk.kind === "toolUse") {
    items.push({ kind: "tool", tool: chunk.tool, summary: chunk.summary ?? "", ts });
    return;
  }
  if (chunk.kind === "fileChange") {
    items.push({ kind: "file", path: chunk.path, op: chunk.op, ts });
    return;
  }
  if (chunk.kind === "raw") {
    items.push({ kind: "meta", label: chunk.type || "raw", detail: "", ts });
  }
}

/** Inclusive seq window for a stage. The latest running/waiting stage stays open. */
export function eventsInStageRange<T extends { seq: number }>(
  events: T[],
  stage: { eventRange: { from: number; to: number }; status: string },
  isLatest: boolean,
): T[] {
  const live = isLatest && (stage.status === "running" || stage.status === "waiting");
  const lastSeq = events.reduce((max, event) => (event.seq > max ? event.seq : max), stage.eventRange.to);
  const to = live ? lastSeq : stage.eventRange.to;
  return events.filter((event) => event.seq >= stage.eventRange.from && event.seq <= to);
}

function summarizeMeta(event: KernelEvent): { label: string; detail: string; tone?: "ok" | "bad" | "warn" } | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "engine.turn.completed": {
      const usage = (p.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
      const files = Array.isArray(p.filesChanged) ? p.filesChanged.length : 0;
      return {
        label: "回合结束",
        detail: `in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}${files ? ` · ${files} 个文件` : ""}`,
      };
    }
    case "artifact.created":
      return { label: "交付件", detail: String(p.key ?? p.artifactId ?? "") };
    case "git.commit":
      return {
        label: "提交",
        detail: `${String(p.sha ?? "").slice(0, 8)} ${String(p.message ?? "").split("\n")[0]}`,
        tone: "ok",
      };
    case "review.completed": {
      const comments = Array.isArray(p.comments) ? p.comments.length : 0;
      return {
        label: "审阅",
        detail: `passed=${String(p.passed)} · comments=${comments}`,
        tone: p.passed === true ? "ok" : "warn",
      };
    }
    case "intervention.required":
      return { label: "介入", detail: String(p.summary ?? p.kind ?? ""), tone: "warn" };
    case "intervention.resolved": {
      const decision = p.decision as { action?: string } | undefined;
      return { label: "介入结果", detail: String(decision?.action ?? "") };
    }
    case "node.retrying":
      return { label: "重试", detail: `#${String(p.attempt)} ${String(p.error ?? "")}`, tone: "bad" };
    case "loop.iteration":
      return { label: "循环", detail: `${p.loopId} ${p.iteration}/${p.maxIterations}` };
    case "instruction.injected":
      return { label: "注入", detail: String(p.text ?? "") };
    case "task.failed":
      return { label: "失败", detail: String(p.error ?? ""), tone: "bad" };
    case "task.suspended":
      return { label: "挂起", detail: String(p.reason ?? ""), tone: "warn" };
    case "log":
      return { label: String(p.level ?? "info"), detail: String(p.message ?? "") };
    case "budget.warning":
      return { label: "预算", detail: String(p.message ?? "warning"), tone: "warn" };
    case "budget.exceeded":
      return { label: "预算耗尽", detail: String(p.message ?? ""), tone: "bad" };
    default:
      return null;
  }
}
