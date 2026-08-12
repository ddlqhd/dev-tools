/**
 * OpenCode CLI (`opencode run`) NDJSON parser.
 *
 * CLI flags (v1.18.x):
 *   opencode run <prompt> --format json [--dir <cwd>] [--thinking]
 *     [-m <provider/model>] [-s <session-id>]
 *     [--agent plan]        # native read-only planning agent
 *     [--auto]              # auto-approve tool permissions
 *
 * Events are one JSON object per line. Relevant types:
 *   step_start / step_finish  — turn lifecycle; step_finish carries tokens+cost
 *   text                      — one complete assistant text part per step
 *   reasoning                 — thinking block (only with --thinking)
 *   tool_use                  — tool call with input/output in part.state
 *   error                     — fatal error (e.g. bad model), exit code 1
 */

import type { EngineChunk, EngineTurnUsage } from "@devtools/shared";

export interface OpenCodeStreamState {
  sessionId?: string;
  /** Assistant text parts in arrival order; the last one is the final reply. */
  textParts: string[];
  finalText?: string;
  filesChanged: Set<string>;
  isError: boolean;
  errorMessage?: string;
  /** Markdown written to `.codeloop-plan.md` via Write/Edit. */
  capturedPlanMarkdown?: string;
  /** JSON text written to `.codeloop-review.json`. */
  capturedReviewJson?: string;
  /** JSON text written to `.codeloop-verify.json`. */
  capturedVerifyJson?: string;
  usage: EngineTurnUsage;
}

/** Record Write/Edit contents for orchestrator artifact files, whatever the path prefix. */
function captureArtifactWrite(state: OpenCodeStreamState, path: string, text: string): void {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (base === ".codeloop-plan.md") state.capturedPlanMarkdown = text;
  if (base === ".codeloop-review.json") state.capturedReviewJson = text;
  if (base === ".codeloop-verify.json") state.capturedVerifyJson = text;
}

/** Arg fields, in priority order, that make a readable one-line tool summary. */
const SUMMARY_KEYS = [
  "filePath",
  "pattern",
  "globPattern",
  "description",
  "command",
  "query",
  "url",
];

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** `apply_patch` -> `ApplyPatch`, so unknown tools still read like the CLI's own names. */
function prettyToolName(tool: string): string {
  return tool
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value);
  }
  return "";
}

export function createOpenCodeStreamState(): OpenCodeStreamState {
  return {
    textParts: [],
    filesChanged: new Set(),
    isError: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function parseOpenCodeStreamLine(
  line: string,
  state: OpenCodeStreamState,
): EngineChunk[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ kind: "raw", type: "parse_error", data: trimmed }];
  }

  const type = event.type;
  const chunks: EngineChunk[] = [];

  // Every event carries the session id on the top level.
  if (typeof event.sessionID === "string") state.sessionId = event.sessionID;

  if (type === "step_start" || type === "step_finish") {
    if (type === "step_finish") {
      const part = (event.part ?? {}) as Record<string, unknown>;
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const inputTokens = num(tokens.input);
      const outputTokens = num(tokens.output) + num(tokens.reasoning);
      state.usage.inputTokens += inputTokens;
      state.usage.outputTokens += outputTokens;
      const cost = typeof part.cost === "number" ? part.cost : undefined;
      if (cost !== undefined) {
        state.usage.costUsd = (state.usage.costUsd ?? 0) + cost;
      }
    }
    return chunks;
  }

  if (type === "text") {
    const part = (event.part ?? {}) as Record<string, unknown>;
    const text = typeof part.text === "string" ? part.text : "";
    if (text) {
      state.textParts.push(text);
      state.finalText = text;
      chunks.push({ kind: "text", text });
    }
    return chunks;
  }

  if (type === "reasoning") {
    const part = (event.part ?? {}) as Record<string, unknown>;
    const text = typeof part.text === "string" ? part.text : "";
    if (text) chunks.push({ kind: "thinking", text });
    return chunks;
  }

  if (type === "tool_use") {
    const part = (event.part ?? {}) as Record<string, unknown>;
    const tool = typeof part.tool === "string" ? part.tool : "unknown";
    const stateObj = (part.state ?? {}) as Record<string, unknown>;
    const input = (stateObj.input ?? {}) as Record<string, unknown>;

    if (tool === "write" || tool === "edit") {
      const filePath = typeof input.filePath === "string" ? input.filePath : "?";
      if (filePath !== "?") state.filesChanged.add(filePath);
      const fileText = tool === "write" ? input.content : input.newString;
      if (typeof fileText === "string") captureArtifactWrite(state, filePath, fileText);
      chunks.push({ kind: "toolUse", tool: prettyToolName(tool), summary: filePath });
      chunks.push({ kind: "fileChange", path: filePath, op: tool === "write" ? "create" : "edit" });
      return chunks;
    }

    const summary = summarizeInput(input) || String(stateObj.title ?? "");
    chunks.push({ kind: "toolUse", tool: prettyToolName(tool), summary });
    return chunks;
  }

  if (type === "error") {
    state.isError = true;
    state.errorMessage = extractErrorMessage(event.error);
    return chunks;
  }

  chunks.push({ kind: "raw", type: String(type ?? "unknown"), data: event });
  return chunks;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    const data = e.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
      if (typeof d.error === "string") return d.error;
    }
  }
  return "opencode reported an error";
}
