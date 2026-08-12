import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenCodeStreamState,
  parseOpenCodeStreamLine,
} from "../src/engines/opencode/stream.js";

function parse(line: string, state = createOpenCodeStreamState()) {
  return { chunks: parseOpenCodeStreamLine(line, state), state };
}

function event(overrides: Record<string, unknown>) {
  return JSON.stringify({
    timestamp: 123,
    sessionID: "ses_1",
    ...overrides,
  });
}

test("step_start: captures sessionId, emits nothing", () => {
  const { chunks, state } = parse(event({ type: "step_start", part: { type: "step-start" } }));
  assert.deepEqual(chunks, []);
  assert.equal(state.sessionId, "ses_1");
});

test("text: appends text, becomes finalText", () => {
  const { chunks, state } = parse(
    event({ type: "text", part: { type: "text", text: "hello" } }),
  );
  assert.deepEqual(chunks, [{ kind: "text", text: "hello" }]);
  assert.equal(state.finalText, "hello");
  assert.deepEqual(state.textParts, ["hello"]);
});

test("reasoning: emits thinking chunk", () => {
  const { chunks } = parse(
    event({ type: "reasoning", part: { type: "reasoning", text: "pondering" } }),
  );
  assert.deepEqual(chunks, [{ kind: "thinking", text: "pondering" }]);
});

test("step_finish: aggregates tokens and cost into usage", () => {
  const state = createOpenCodeStreamState();
  parse(
    event({
      type: "step_finish",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { total: 100, input: 80, output: 15, reasoning: 5 },
        cost: 0.001,
      },
    }),
    state,
  );
  parse(
    event({
      type: "step_finish",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { total: 50, input: 30, output: 20, reasoning: 0 },
        cost: 0.002,
      },
    }),
    state,
  );
  assert.equal(state.usage.inputTokens, 110);
  assert.equal(state.usage.outputTokens, 40);
  assert.equal(state.usage.costUsd, 0.003);
});

test("tool_use write: filesChanged + artifact capture + chunks", () => {
  const { chunks, state } = parse(
    event({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: {
          status: "completed",
          input: {
            filePath: "/repo/.codeloop-review.json",
            content: '{"passed":true}',
          },
        },
      },
    }),
  );
  assert.deepEqual(chunks, [
    { kind: "toolUse", tool: "Write", summary: "/repo/.codeloop-review.json" },
    { kind: "fileChange", path: "/repo/.codeloop-review.json", op: "create" },
  ]);
  assert.ok(state.filesChanged.has("/repo/.codeloop-review.json"));
  assert.equal(state.capturedReviewJson, '{"passed":true}');
});

test("tool_use write verify artifact + plan markdown capture", () => {
  const { state: s1 } = parse(
    event({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        state: {
          input: { filePath: "/repo/.codeloop-verify.json", content: '{"passed":false}' },
        },
      },
    }),
  );
  assert.equal(s1.capturedVerifyJson, '{"passed":false}');

  const { state: s2 } = parse(
    event({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: {
          input: { filePath: "/repo/.codeloop-plan.md", newString: "# Goal\n\nplan body" },
        },
      },
    }),
  );
  assert.equal(s2.capturedPlanMarkdown, "# Goal\n\nplan body");
});

test("tool_use edit: emits edit fileChange", () => {
  const { chunks, state } = parse(
    event({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: { input: { filePath: "src/a.ts", oldString: "a", newString: "b" } },
      },
    }),
  );
  assert.deepEqual(chunks, [
    { kind: "toolUse", tool: "Edit", summary: "src/a.ts" },
    { kind: "fileChange", path: "src/a.ts", op: "edit" },
  ]);
  assert.ok(state.filesChanged.has("src/a.ts"));
});

test("tool_use read/bash/glob summaries", () => {
  const read = parse(
    event({
      type: "tool_use",
      part: { type: "tool", tool: "read", state: { input: { filePath: "/repo/a.ts" } } },
    }),
  );
  assert.deepEqual(read.chunks, [{ kind: "toolUse", tool: "Read", summary: "/repo/a.ts" }]);

  const bash = parse(
    event({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        state: { input: { command: "pnpm test", description: "run tests" } },
      },
    }),
  );
  assert.deepEqual(bash.chunks, [{ kind: "toolUse", tool: "Bash", summary: "run tests" }]);

  const glob = parse(
    event({
      type: "tool_use",
      part: { type: "tool", tool: "glob", state: { input: { pattern: "src/**/*.ts" } } },
    }),
  );
  assert.deepEqual(glob.chunks, [{ kind: "toolUse", tool: "Glob", summary: "src/**/*.ts" }]);
});

test("tool_use unknown tool: pretty name + summarized input", () => {
  const { chunks } = parse(
    event({
      type: "tool_use",
      part: { type: "tool", tool: "apply_patch", state: { input: { filePath: "/x/y" } } },
    }),
  );
  assert.deepEqual(chunks, [{ kind: "toolUse", tool: "ApplyPatch", summary: "/x/y" }]);
});

test("error: sets isError with nested message", () => {
  const { state } = parse(
    event({
      type: "error",
      error: { name: "UnknownError", data: { message: "Unexpected server error" } },
    }),
  );
  assert.equal(state.isError, true);
  assert.equal(state.errorMessage, "Unexpected server error");
});

test("unknown event type: raw passthrough", () => {
  const { chunks } = parse(event({ type: "message", part: { type: "banner" } }));
  assert.equal(chunks[0]?.kind, "raw");
  assert.equal(chunks[0]?.type, "message");
});

test("malformed line: raw parse_error chunk", () => {
  const { chunks } = parse("this is not json {");
  assert.deepEqual(chunks, [{ kind: "raw", type: "parse_error", data: "this is not json {" }]);
});

test("blank line: no chunks", () => {
  const { chunks } = parse("   ");
  assert.deepEqual(chunks, []);
});
