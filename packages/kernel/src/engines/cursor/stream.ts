/**
 * Cursor CLI (`agent`) stream-json parser.
 *
 * CLI flags (v2026.08.04):
 *   agent -p --output-format stream-json [--stream-partial-output]
 *     --trust --workspace <cwd>
 *     [--mode plan]          # readonly
 *     [--force]              # allow writes/commands in print mode
 *     [--model <model>]
 *     [--resume <chatId>]
 *     [--sandbox enabled|disabled]
 *
 * With --stream-partial-output, only assistant events that have timestamp_ms
 * and lack model_call_id are real deltas; use terminal `result` for final text.
 */

import type { EngineChunk } from "@devtools/shared";

export interface CursorStreamState {
  sessionId?: string;
  textParts: string[];
  filesChanged: Set<string>;
  finalText?: string;
  isError: boolean;
  errorMessage?: string;
}

export function createCursorStreamState(): CursorStreamState {
  return {
    textParts: [],
    filesChanged: new Set(),
    isError: false,
  };
}

export function parseCursorStreamLine(
  line: string,
  state: CursorStreamState,
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

  if (type === "system" && event.subtype === "init") {
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    return chunks;
  }

  if (type === "assistant") {
    const hasTimestamp = typeof event.timestamp_ms === "number";
    const hasModelCallId = typeof event.model_call_id === "string";
    // Streaming delta: timestamp present, model_call_id absent
    // Without --stream-partial-output: full assistant messages (no timestamp) — still emit text
    const isDelta = hasTimestamp && !hasModelCallId;
    const isCompleteMessage = !hasTimestamp && !hasModelCallId;
    const isDuplicateFlush = hasModelCallId;

    if (isDuplicateFlush) return chunks;

    const message = event.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const text = (message?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("");

    if (text && (isDelta || isCompleteMessage)) {
      if (isDelta) state.textParts.push(text);
      chunks.push({ kind: "text", text });
    }
    return chunks;
  }

  if (type === "tool_call" && event.subtype === "started") {
    const toolCall = event.tool_call as Record<string, unknown> | undefined;
    if (!toolCall) return chunks;

    if (toolCall.readToolCall) {
      const args = (toolCall.readToolCall as { args?: { path?: string } }).args;
      const path = args?.path ?? "?";
      chunks.push({ kind: "toolUse", tool: "Read", summary: path });
      return chunks;
    }

    if (toolCall.writeToolCall) {
      const args = (toolCall.writeToolCall as { args?: { path?: string } }).args;
      const path = args?.path ?? "?";
      state.filesChanged.add(path);
      chunks.push({ kind: "toolUse", tool: "Write", summary: path });
      chunks.push({ kind: "fileChange", path, op: "create" });
      return chunks;
    }

    if (toolCall.function) {
      const fn = toolCall.function as { name?: string; arguments?: string };
      const name = fn.name ?? "function";
      let summary = "";
      try {
        const parsed = JSON.parse(fn.arguments ?? "{}") as Record<string, unknown>;
        summary = String(parsed.path ?? parsed.command ?? parsed.file ?? "");
        if (typeof parsed.path === "string") {
          state.filesChanged.add(parsed.path);
          if (/edit|write|replace|strreplace/i.test(name)) {
            chunks.push({ kind: "fileChange", path: parsed.path, op: "edit" });
          }
        }
      } catch {
        summary = (fn.arguments ?? "").slice(0, 120);
      }
      chunks.push({ kind: "toolUse", tool: name, summary });
      return chunks;
    }

    const key = Object.keys(toolCall)[0] ?? "unknown";
    chunks.push({ kind: "toolUse", tool: key, summary: "" });
    chunks.push({ kind: "raw", type: "tool_call", data: toolCall });
    return chunks;
  }

  if (type === "tool_call" && event.subtype === "completed") {
    const toolCall = event.tool_call as Record<string, unknown> | undefined;
    if (toolCall?.writeToolCall) {
      const result = (
        toolCall.writeToolCall as {
          result?: { success?: { path?: string } };
          args?: { path?: string };
        }
      ).result?.success;
      const argsPath = (toolCall.writeToolCall as { args?: { path?: string } }).args?.path;
      const path = result?.path ?? argsPath;
      if (path) {
        state.filesChanged.add(path);
        chunks.push({ kind: "fileChange", path, op: "edit" });
      }
    }
    return chunks;
  }

  if (type === "result") {
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.is_error === true || event.subtype === "error") {
      state.isError = true;
      state.errorMessage =
        typeof event.result === "string"
          ? event.result
          : typeof event.error === "string"
            ? event.error
            : "Cursor agent reported an error";
    } else if (typeof event.result === "string") {
      state.finalText = event.result;
    }
    return chunks;
  }

  chunks.push({ kind: "raw", type: String(type ?? "unknown"), data: event });
  return chunks;
}
