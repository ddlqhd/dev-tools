import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PlainRenderer } from "../src/plain.js";
import type { KernelEvent } from "@devtools/shared";

let lines: string[];
let writeMock: ReturnType<typeof mock.method<typeof process.stdout, "write">> | undefined;

function event(type: KernelEvent["type"], payload: unknown): KernelEvent {
  return { seq: 1, taskId: "t1", ts: new Date().toISOString(), type, payload };
}

beforeEach(() => {
  lines = [];
  writeMock = mock.method(process.stdout, "write", (chunk: string) => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeMock?.mock.restore();
});

function output(): string {
  return lines.join("");
}

test("plain: task lifecycle lines", () => {
  const r = new PlainRenderer();
  r.print(event("task.created", { pipeline: { name: "quick-fix" } }));
  r.print(event("task.started", {}));
  r.print(event("loop.iteration", { loopId: "planLoop", iteration: 1, maxIterations: 3 }));
  r.print(event("node.started", { nodeId: "plan", primitive: "agent", engine: "planner" }));
  r.print(event("node.completed", { nodeId: "plan" }));
  r.print(event("task.completed", {}));
  r.end();
  const out = output();
  assert.match(out, /\[task\] created pipeline=quick-fix/);
  assert.match(out, /\[task\] started/);
  assert.match(out, /\[loop\] planLoop 1\/3/);
  assert.match(out, /\[node\] ▶ plan \(agent, planner\)/);
  assert.match(out, /\[node\] ✓ plan/);
  assert.match(out, /\[task\] completed/);
});

test("plain: streamed engine text is written inline without extra newline", () => {
  const r = new PlainRenderer();
  r.print(event("engine.chunk", { chunk: { kind: "text", text: "hello " } }));
  r.print(event("engine.chunk", { chunk: { kind: "text", text: "world" } }));
  r.end();
  assert.equal(output(), "hello world\n");
});

test("plain: toolUse and fileChange chunks render on their own lines", () => {
  const r = new PlainRenderer();
  r.print(event("engine.chunk", { chunk: { kind: "toolUse", tool: "Grep", summary: "TODO" } }));
  r.print(event("engine.chunk", { chunk: { kind: "fileChange", path: "src/a.ts", op: "edit" } }));
  r.end();
  const out = output();
  assert.match(out, /⚙ Grep TODO/);
  assert.match(out, /✎ src\/a\.ts \(edit\)/);
});

test("plain: review and intervention lines", () => {
  const r = new PlainRenderer();
  r.print(
    event("review.completed", {
      comments: [{ id: "c1", severity: "major", comment: "x", status: "open" }],
      passed: false,
    }),
  );
  r.print(
    event("intervention.required", {
      requestId: "r1",
      nodeId: "planGate",
      kind: "gate",
      summary: "approve?",
    }),
  );
  r.end();
  const out = output();
  assert.match(out, /\[review\] passed=false comments=1/);
  assert.match(out, /\[intervene\] gate: approve\? \(r1\)/);
});

test("plain: git commit line truncates sha", () => {
  const r = new PlainRenderer();
  r.print(event("git.commit", { sha: "0123456789abcdef", message: "feat: stub change" }));
  r.end();
  assert.match(output(), /\[git\] commit 01234567 — feat: stub change/);
});

test("plain: unknown event types are ignored", () => {
  const r = new PlainRenderer();
  r.print({ seq: 1, taskId: "t1", ts: new Date().toISOString(), type: "task.created", payload: {} });
  // @ts-expect-error deliberately malformed event type
  r.print({ seq: 2, taskId: "t1", ts: new Date().toISOString(), type: "mystery.event", payload: {} });
  r.end();
  assert.match(output(), /\[task\] created/);
});
