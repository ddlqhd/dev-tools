import type {
  EngineChunk,
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  ReviewComment,
} from "@devtools/shared";

export type UiMode = "run" | "watch";

export type TaskUiStatus =
  | "idle"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "aborted";

export type StreamKind = "text" | "thinking";

export interface UiMeta {
  mode: UiMode;
  taskId?: string;
  pipeline?: string;
  branch?: string;
  repoPath?: string;
  requirement?: string;
  /** `host:port` of the daemon when attached over the network. */
  endpoint?: string;
}

/** One immutable line (or block) in the scrollback log. */
export type LogBody =
  | { kind: "header"; meta: UiMeta }
  | {
      kind: "nodeStart";
      nodeId: string;
      primitive: string;
      engine?: string;
      model?: string;
      loopLabel?: string;
    }
  | {
      kind: "nodeDone";
      nodeId: string;
      primitive: string;
      durationMs?: number;
      tools: number;
      files: number;
      outcome?: string;
    }
  | { kind: "nodeRetry"; nodeId: string; attempt: number; error: string }
  | { kind: "tool"; tool: string; summary: string }
  | { kind: "file"; path: string; op: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "commit"; sha: string; message: string }
  | { kind: "review"; passed: boolean; comments: ReviewComment[] }
  | { kind: "artifact"; key: string; path: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: "loop"; loopId: string; iteration: number; maxIterations: number }
  | { kind: "intervention"; request: InterventionRequest }
  | { kind: "resolved"; action: string; detail?: string }
  | { kind: "inject"; text: string }
  | { kind: "status"; status: TaskUiStatus; detail?: string }
  | { kind: "log"; level: string; message: string }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

export type LogEntry = LogBody & { id: number };

export interface ActiveNode {
  nodeId: string;
  primitive: string;
  engine?: string;
  model?: string;
  startedAt: number;
  tools: number;
  files: number;
  lastTool?: string;
  lastFile?: string;
}

export interface UiCounters {
  tools: number;
  files: number;
  commits: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LoopFrame {
  loopId: string;
  iteration: number;
}

export interface UiState {
  meta: UiMeta;
  status: TaskUiStatus;
  startedAt?: number;
  finishedAt?: number;
  entries: LogEntry[];
  nextId: number;
  headerShown: boolean;
  activeNode?: ActiveNode;
  loopStack: LoopFrame[];
  loopMax: Record<string, number>;
  stream: { kind: StreamKind; partial: string } | null;
  counters: UiCounters;
  pending: InterventionRequest | null;
  /** A decision is in flight (remote POST); keeps the panel visible but locked. */
  pendingBusy: boolean;
  pendingError?: string;
  resolvedRequestIds: Record<string, true>;
  snapshotNode?: string;
  error?: string;
}

export type UiAction =
  | { type: "event"; event: KernelEvent }
  | { type: "meta"; meta: Partial<UiMeta> }
  | { type: "header" }
  | {
      type: "hydrate";
      status: TaskUiStatus;
      startedAt?: number;
      currentNode?: string;
      error?: string;
    }
  | { type: "pending"; request: InterventionRequest }
  | { type: "submitStart"; requestId: string }
  | { type: "submitError"; requestId: string; message: string }
  | { type: "submitDone"; requestId: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "finish"; status: TaskUiStatus; error?: string };

export function initialState(meta: UiMeta): UiState {
  return {
    meta,
    status: "idle",
    entries: [],
    nextId: 0,
    headerShown: false,
    loopStack: [],
    loopMax: {},
    stream: null,
    counters: {
      tools: 0,
      files: 0,
      commits: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    pending: null,
    pendingBusy: false,
    resolvedRequestIds: {},
  };
}

/** Accumulates appended entries so each action produces a single array copy. */
class Appender {
  readonly bodies: LogBody[] = [];

  push(body: LogBody): void {
    this.bodies.push(body);
  }

  commit(state: UiState): UiState {
    if (this.bodies.length === 0) return state;
    const entries = state.entries.slice();
    let nextId = state.nextId;
    for (const body of this.bodies) {
      entries.push({ ...body, id: nextId } as LogEntry);
      nextId += 1;
    }
    return { ...state, entries, nextId };
  }
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "meta": {
      const meta = { ...state.meta, ...action.meta };
      return { ...state, meta };
    }
    case "header":
      return showHeader(state);
    case "hydrate":
      return {
        ...state,
        status: action.status,
        startedAt: action.startedAt ?? state.startedAt,
        snapshotNode: action.currentNode,
        error: action.error,
      };
    case "event":
      return applyEvent(state, action.event);
    case "pending": {
      if (state.resolvedRequestIds[action.request.requestId]) return state;
      if (state.pending?.requestId === action.request.requestId) return state;
      const next = flushStream(state);
      return { ...next, pending: action.request, pendingBusy: false, pendingError: undefined };
    }
    case "submitStart":
      if (state.pending?.requestId !== action.requestId) return state;
      return { ...state, pendingBusy: true, pendingError: undefined };
    case "submitError":
      if (state.pending?.requestId !== action.requestId) return state;
      return { ...state, pendingBusy: false, pendingError: action.message };
    case "submitDone": {
      if (state.pending?.requestId !== action.requestId) return state;
      return {
        ...state,
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
        resolvedRequestIds: { ...state.resolvedRequestIds, [action.requestId]: true },
      };
    }
    case "notice": {
      const next = flushStream(state);
      const appender = new Appender();
      appender.push({ kind: "notice", level: action.level, text: action.text });
      return appender.commit(next);
    }
    case "finish": {
      const next = flushStream(state);
      const appender = new Appender();
      if (next.status !== action.status) {
        appender.push({ kind: "status", status: action.status, detail: action.error });
      }
      return {
        ...appender.commit(next),
        status: action.status,
        finishedAt: Date.now(),
        error: action.error ?? next.error,
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
        snapshotNode: undefined,
      };
    }
    default:
      return state;
  }
}

function showHeader(state: UiState): UiState {
  if (state.headerShown) return state;
  const appender = new Appender();
  appender.push({ kind: "header", meta: state.meta });
  return { ...appender.commit(state), headerShown: true };
}

/** Move any buffered partial stream line into the log so ordering stays intact. */
function flushStream(state: UiState): UiState {
  if (!state.stream) return state;
  const { kind, partial } = state.stream;
  const cleared: UiState = { ...state, stream: null };
  if (!partial.trim()) return cleared;
  const appender = new Appender();
  appender.push({ kind, text: partial });
  return appender.commit(cleared);
}

function applyEvent(state: UiState, event: KernelEvent): UiState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const at = eventTimestamp(event);

  if (event.type === "engine.chunk") {
    const chunk = payload.chunk as EngineChunk | undefined;
    if (chunk && (chunk.kind === "text" || chunk.kind === "thinking")) {
      return applyStreamChunk(state, chunk.kind, chunk.text ?? "");
    }
  }

  let next = flushStream(state);
  const appender = new Appender();

  switch (event.type) {
    case "task.created": {
      const pipeline = payload.pipeline as { name?: string } | undefined;
      next = {
        ...next,
        meta: {
          ...next.meta,
          taskId: next.meta.taskId ?? event.taskId,
          pipeline: pipeline?.name ?? next.meta.pipeline,
          branch: (payload.branch as string | undefined) ?? next.meta.branch,
          repoPath: (payload.repoPath as string | undefined) ?? next.meta.repoPath,
          requirement: (payload.requirement as string | undefined) ?? next.meta.requirement,
        },
      };
      next = showHeader(next);
      break;
    }
    case "task.started":
      next = { ...next, status: "running", startedAt: next.startedAt ?? at };
      appender.push({ kind: "status", status: "running" });
      break;
    case "task.resumed":
      next = {
        ...next,
        status: "running",
        startedAt: next.startedAt ?? at,
        resolvedRequestIds: {},
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
      };
      appender.push({
        kind: "status",
        status: "running",
        detail: `resumed @ ${String(payload.nodeId ?? "-")}`,
      });
      break;
    case "task.suspended":
      next = { ...next, status: "suspended", activeNode: undefined };
      appender.push({
        kind: "status",
        status: "suspended",
        detail: payload.reason ? String(payload.reason) : undefined,
      });
      break;
    case "task.completed":
      next = {
        ...next,
        status: "completed",
        finishedAt: at,
        activeNode: undefined,
        snapshotNode: undefined,
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
      };
      appender.push({ kind: "status", status: "completed" });
      break;
    case "task.failed": {
      const error = payload.error ? String(payload.error) : undefined;
      next = {
        ...next,
        status: "failed",
        finishedAt: at,
        activeNode: undefined,
        snapshotNode: undefined,
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
        error,
      };
      appender.push({ kind: "status", status: "failed", detail: error });
      break;
    }
    case "task.aborted":
      next = {
        ...next,
        status: "aborted",
        finishedAt: at,
        activeNode: undefined,
        snapshotNode: undefined,
        pending: null,
        pendingBusy: false,
        pendingError: undefined,
      };
      appender.push({ kind: "status", status: "aborted" });
      break;
    case "node.started": {
      const nodeId = String(payload.nodeId ?? "?");
      const primitive = String(payload.primitive ?? "node");
      const engine = payload.engine ? String(payload.engine) : undefined;
      const model = payload.model ? String(payload.model) : undefined;
      const loopStack = Array.isArray(payload.loopStack)
        ? (payload.loopStack as LoopFrame[])
        : next.loopStack;
      next = {
        ...next,
        status: isTerminalStatus(next.status) ? next.status : "running",
        startedAt: next.startedAt ?? at,
        loopStack,
        snapshotNode: undefined,
        activeNode: {
          nodeId,
          primitive,
          engine,
          model,
          startedAt: at,
          tools: 0,
          files: 0,
        },
      };
      appender.push({
        kind: "nodeStart",
        nodeId,
        primitive,
        engine,
        model,
        loopLabel: loopLabel(next),
      });
      break;
    }
    case "node.completed": {
      const nodeId = String(payload.nodeId ?? "?");
      const active = next.activeNode;
      appender.push({
        kind: "nodeDone",
        nodeId,
        primitive: active?.primitive ?? "node",
        durationMs: active && active.nodeId === nodeId ? at - active.startedAt : undefined,
        tools: active?.nodeId === nodeId ? active.tools : 0,
        files: active?.nodeId === nodeId ? active.files : 0,
        outcome: summarizeOutcome(payload.outcome),
      });
      if (active?.nodeId === nodeId || next.snapshotNode === nodeId) {
        next = { ...next, activeNode: undefined, snapshotNode: undefined };
      }
      break;
    }
    case "node.retrying":
      appender.push({
        kind: "nodeRetry",
        nodeId: String(payload.nodeId ?? "?"),
        attempt: Number(payload.attempt ?? 0),
        error: String(payload.error ?? ""),
      });
      break;
    case "loop.iteration": {
      const loopId = String(payload.loopId ?? "?");
      const iteration = Number(payload.iteration ?? 0);
      const maxIterations = Number(payload.maxIterations ?? 0);
      const others = next.loopStack.filter((f) => f.loopId !== loopId);
      next = {
        ...next,
        loopStack: [...others, { loopId, iteration }],
        loopMax: { ...next.loopMax, [loopId]: maxIterations },
      };
      appender.push({ kind: "loop", loopId, iteration, maxIterations });
      break;
    }
    case "engine.chunk": {
      const chunk = payload.chunk as EngineChunk | undefined;
      if (!chunk) break;
      if (chunk.kind === "toolUse") {
        next = bumpNode(next, { tools: 1, lastTool: chunk.tool });
        next = { ...next, counters: { ...next.counters, tools: next.counters.tools + 1 } };
        appender.push({ kind: "tool", tool: chunk.tool, summary: chunk.summary ?? "" });
      } else if (chunk.kind === "fileChange") {
        next = bumpNode(next, { files: 1, lastFile: chunk.path });
        next = { ...next, counters: { ...next.counters, files: next.counters.files + 1 } };
        appender.push({ kind: "file", path: chunk.path, op: chunk.op });
      }
      break;
    }
    case "engine.turn.completed": {
      const usage = payload.usage as
        | { inputTokens?: number; outputTokens?: number; costUsd?: number }
        | undefined;
      next = {
        ...next,
        counters: {
          ...next.counters,
          turns: next.counters.turns + 1,
          inputTokens: next.counters.inputTokens + (usage?.inputTokens ?? 0),
          outputTokens: next.counters.outputTokens + (usage?.outputTokens ?? 0),
          costUsd: next.counters.costUsd + (usage?.costUsd ?? 0),
        },
      };
      if (usage && (usage.inputTokens || usage.outputTokens || usage.costUsd)) {
        appender.push({
          kind: "usage",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          costUsd: usage.costUsd,
        });
      }
      break;
    }
    case "git.commit": {
      const sha = String(payload.sha ?? "");
      const message = String(payload.message ?? "").split("\n")[0] ?? "";
      next = { ...next, counters: { ...next.counters, commits: next.counters.commits + 1 } };
      appender.push({ kind: "commit", sha, message });
      break;
    }
    case "review.completed":
      appender.push({
        kind: "review",
        passed: payload.passed === true,
        comments: Array.isArray(payload.comments) ? (payload.comments as ReviewComment[]) : [],
      });
      break;
    case "intervention.required": {
      const request: InterventionRequest = {
        requestId: String(payload.requestId ?? ""),
        nodeId: String(payload.nodeId ?? ""),
        kind: (payload.kind as InterventionRequest["kind"]) ?? "gate",
        summary: String(payload.summary ?? ""),
      };
      if (next.resolvedRequestIds[request.requestId]) break;
      const sameRequest = next.pending?.requestId === request.requestId;
      appender.push({ kind: "intervention", request });
      next = {
        ...next,
        status: "suspended",
        pending: sameRequest ? next.pending : request,
        pendingBusy: sameRequest ? next.pendingBusy : false,
        pendingError: sameRequest ? next.pendingError : undefined,
      };
      break;
    }
    case "intervention.resolved": {
      const decision = payload.decision as InterventionDecision | undefined;
      const requestId = String(payload.requestId ?? "");
      appender.push({
        kind: "resolved",
        action: decision?.action ?? "resolved",
        detail: describeDecision(decision),
      });
      const resolvesCurrent = !next.pending || next.pending.requestId === requestId;
      next = {
        ...next,
        status:
          resolvesCurrent && !isTerminalStatus(next.status) ? "running" : next.status,
        resolvedRequestIds: requestId
          ? { ...next.resolvedRequestIds, [requestId]: true }
          : next.resolvedRequestIds,
      };
      if (resolvesCurrent) {
        next = { ...next, pending: null, pendingBusy: false, pendingError: undefined };
      }
      break;
    }
    case "instruction.injected":
      appender.push({ kind: "inject", text: String(payload.text ?? "") });
      break;
    case "artifact.created":
      appender.push({
        kind: "artifact",
        key: String(payload.key ?? ""),
        path: String(payload.path ?? ""),
      });
      break;
    case "log":
      appender.push({
        kind: "log",
        level: String(payload.level ?? "info"),
        message: String(payload.message ?? ""),
      });
      break;
    case "budget.warning":
      appender.push({ kind: "notice", level: "warn", text: budgetText(payload, "budget warning") });
      break;
    case "budget.exceeded":
      appender.push({ kind: "notice", level: "error", text: budgetText(payload, "budget exceeded") });
      break;
    default:
      break;
  }

  return appender.commit(next);
}

function applyStreamChunk(state: UiState, kind: StreamKind, text: string): UiState {
  if (!text) return state;
  let next = state;
  if (next.stream && next.stream.kind !== kind) next = flushStream(next);

  const buffer = (next.stream?.partial ?? "") + text;
  const segments = buffer.split("\n");
  const partial = segments.pop() ?? "";
  const appender = new Appender();
  let lastWasBlank = false;
  for (const segment of segments) {
    const line = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
    const blank = line.trim() === "";
    // Collapse runs of blank lines — agent markdown is full of them.
    if (blank && lastWasBlank) continue;
    lastWasBlank = blank;
    appender.push({ kind, text: line });
  }

  return appender.commit({ ...next, stream: { kind, partial } });
}

function bumpNode(
  state: UiState,
  delta: { tools?: number; files?: number; lastTool?: string; lastFile?: string },
): UiState {
  if (!state.activeNode) return state;
  return {
    ...state,
    activeNode: {
      ...state.activeNode,
      tools: state.activeNode.tools + (delta.tools ?? 0),
      files: state.activeNode.files + (delta.files ?? 0),
      lastTool: delta.lastTool ?? state.activeNode.lastTool,
      lastFile: delta.lastFile ?? state.activeNode.lastFile,
    },
  };
}

export function loopLabel(state: UiState): string | undefined {
  if (state.loopStack.length === 0) return undefined;
  return state.loopStack
    .map((frame) => {
      const max = state.loopMax[frame.loopId];
      return `${frame.loopId} ${frame.iteration}${max ? `/${max}` : ""}`;
    })
    .join(" › ");
}

function summarizeOutcome(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(outcome as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      if (value) parts.push(key);
      continue;
    }
    if (typeof value === "number" || typeof value === "string") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function describeDecision(decision: InterventionDecision | undefined): string | undefined {
  if (!decision) return undefined;
  if (decision.action === "reject") {
    return decision.comments.map((c) => c.comment).join("; ") || undefined;
  }
  if (decision.action === "edit") return decision.note || undefined;
  return undefined;
}

function budgetText(payload: Record<string, unknown>, fallback: string): string {
  const parts: string[] = [];
  for (const key of ["metric", "used", "limit", "reason"]) {
    const value = payload[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? `${fallback} (${parts.join(" ")})` : fallback;
}

function eventTimestamp(event: KernelEvent): number {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isTerminalStatus(status: TaskUiStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}
