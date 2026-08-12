import { test } from "node:test";
import assert from "node:assert/strict";
import { createCursorStreamState, parseCursorStreamLine } from "../src/engines/cursor/stream.js";

function parse(line: string, state = createCursorStreamState()) {
  return { chunks: parseCursorStreamLine(line, state), state };
}

test("system/init: captures sessionId, emits nothing", () => {
  const { chunks, state } = parse(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }));
  assert.deepEqual(chunks, []);
  assert.equal(state.sessionId, "sess-1");
});

test("assistant delta: appends text and marks streaming", () => {
  const { chunks, state } = parse(
    JSON.stringify({
      type: "assistant",
      timestamp_ms: 123,
      message: { content: [{ type: "text", text: "hello " }] },
    }),
  );
  assert.deepEqual(chunks, [{ kind: "text", text: "hello " }]);
  assert.equal(state.sawTextDelta, true);
  assert.deepEqual(state.textParts, ["hello "]);
});

test("assistant complete message: emitted only when no deltas yet", () => {
  const msg = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "full reply" }] },
  });
  const { chunks } = parse(msg);
  assert.deepEqual(chunks, [{ kind: "text", text: "full reply" }]);

  // With a prior delta, the trailing complete message is suppressed as duplicate
  const state = createCursorStreamState();
  state.sawTextDelta = true;
  const { chunks: chunks2 } = parse(msg, state);
  assert.deepEqual(chunks2, []);
});

test("assistant with model_call_id is a duplicate flush: ignored", () => {
  const { chunks } = parse(
    JSON.stringify({
      type: "assistant",
      timestamp_ms: 1,
      model_call_id: "m1",
      message: { content: [{ type: "text", text: "dup" }] },
    }),
  );
  assert.deepEqual(chunks, []);
});

test("thinking delta/completed", () => {
  const { chunks } = parse(JSON.stringify({ type: "thinking", subtype: "delta", text: "pondering" }));
  assert.deepEqual(chunks, [{ kind: "thinking", text: "pondering" }]);
  const { chunks: c2 } = parse(JSON.stringify({ type: "thinking", subtype: "completed" }));
  assert.deepEqual(c2, [{ kind: "thinking", text: "\n" }]);
});

test("user echo: ignored", () => {
  const { chunks } = parse(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "prompt" }] } }));
  assert.deepEqual(chunks, []);
});

test("tool_call write: filesChanged + artifact capture + chunks", () => {
  const { chunks, state } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: {
        writeToolCall: {
          args: { path: ".codeloop-review.json", fileText: '{"passed":true}' },
        },
      },
    }),
  );
  assert.deepEqual(chunks, [
    { kind: "toolUse", tool: "Write", summary: ".codeloop-review.json" },
    { kind: "fileChange", path: ".codeloop-review.json", op: "create" },
  ]);
  assert.ok(state.filesChanged.has(".codeloop-review.json"));
  assert.equal(state.capturedReviewJson, '{"passed":true}');
});

test("tool_call write completed: fills capture when started missed it", () => {
  const { state } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        writeToolCall: {
          args: { path: ".codeloop-verify.json", fileText: '{"passed":false}' },
        },
      },
    }),
  );
  assert.equal(state.capturedVerifyJson, '{"passed":false}');
  assert.ok(state.filesChanged.has(".codeloop-verify.json"));
});

test("tool_call edit: emits edit fileChange once", () => {
  const { chunks, state } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: {
        editToolCall: { args: { path: "src/a.ts", streamContent: "code" } },
      },
    }),
  );
  assert.deepEqual(chunks, [
    { kind: "toolUse", tool: "Edit", summary: "src/a.ts" },
    { kind: "fileChange", path: "src/a.ts", op: "edit" },
  ]);
  assert.equal(state.capturedPlanMarkdown, undefined);
});

test("tool_call createPlanToolCall: extracts plan markdown from overview", () => {
  const overview = `# Goal

Implement feature X

# Approach

1. One
2. Two

# Files likely to change

- src/a.ts

# Risks

none

# Test plan

test it`;
  const { chunks, state } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: {
        createPlanToolCall: { args: { name: "Plan X", overview } },
      },
    }),
  );
  assert.equal(chunks[0]?.kind, "toolUse");
  assert.ok(state.capturedPlanMarkdown?.includes("Goal"));
  assert.ok(state.capturedPlanMarkdown!.length > 40);
});

test("tool_call createPlanToolCall: builds markdown from name/overview/todos", () => {
  const { state } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: {
        createPlanToolCall: {
          args: { name: "Refactor", overview: "Short.", todos: ["step one", "step two"] },
        },
      },
    }),
  );
  assert.match(state.capturedPlanMarkdown ?? "", /^# Refactor/);
  assert.match(state.capturedPlanMarkdown ?? "", /## Steps/);
  assert.match(state.capturedPlanMarkdown ?? "", /step one/);
});

test("tool_call shell/grep/glob summaries", () => {
  const shell = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { args: { command: "pnpm test", description: "run tests" } } },
    }),
  );
  assert.deepEqual(shell.chunks, [{ kind: "toolUse", tool: "Shell", summary: "run tests" }]);

  const grep = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { grepToolCall: { args: { pattern: "TODO" } } },
    }),
  );
  assert.deepEqual(grep.chunks, [{ kind: "toolUse", tool: "Grep", summary: "TODO" }]);

  const glob = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { globToolCall: { args: { globPattern: "src/**/*.ts" } } },
    }),
  );
  assert.deepEqual(glob.chunks, [{ kind: "toolUse", tool: "Glob", summary: "src/**/*.ts" }]);
});

test("tool_call unknown key: pretty tool name + summarized args", () => {
  const { chunks } = parse(
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { frobnicateToolCall: { args: { path: "/x/y" } } },
    }),
  );
  assert.deepEqual(chunks, [{ kind: "toolUse", tool: "Frobnicate", summary: "/x/y" }]);
});

test("result: sets sessionId and finalText", () => {
  const { chunks, state } = parse(
    JSON.stringify({ type: "result", session_id: "sess-2", result: "done here" }),
  );
  assert.deepEqual(chunks, []);
  assert.equal(state.sessionId, "sess-2");
  assert.equal(state.finalText, "done here");
  assert.equal(state.isError, false);
});

test("result: error sets isError + message", () => {
  const { state } = parse(JSON.stringify({ type: "result", is_error: true, result: "boom" }));
  assert.equal(state.isError, true);
  assert.equal(state.errorMessage, "boom");
});

test("malformed line: raw parse_error chunk", () => {
  const { chunks } = parse("this is not json {");
  assert.deepEqual(chunks, [{ kind: "raw", type: "parse_error", data: "this is not json {" }]);
});

test("blank line: no chunks", () => {
  const { chunks } = parse("   ");
  assert.deepEqual(chunks, []);
});
