import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, type UiState } from "../src/ui/reducer.js";
import type { KernelEvent } from "@devtools/shared";

type UiAction = Parameters<typeof reduce>[1];

function event(type: KernelEvent["type"], payload: unknown, seq = 1): KernelEvent {
  return { seq, taskId: "t1", ts: new Date().toISOString(), type, payload };
}

function play(actions: UiAction[]): UiState {
  let state = initialState({ mode: "run", pipeline: "p" });
  for (const a of actions) state = reduce(state, a);
  return state;
}

const started = event("task.started", {});

test("initialState: defaults", () => {
  const s = initialState({ mode: "watch", taskId: "t1" });
  assert.equal(s.status, "idle");
  assert.equal(s.meta.mode, "watch");
  assert.deepEqual(s.entries, []);
  assert.equal(s.nextId, 0);
  assert.equal(s.headerShown, false);
  assert.deepEqual(s.counters, {
    tools: 0,
    files: 0,
    commits: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  assert.equal(s.pending, null);
  assert.equal(s.stream, null);
});

test("hydrate: sets status, startedAt, snapshotNode", () => {
  const s = play([{ type: "hydrate", status: "suspended", currentNode: "planGate", error: "x" }]);
  assert.equal(s.status, "suspended");
  assert.equal(s.snapshotNode, "planGate");
  assert.equal(s.error, "x");
});

test("task.created fills meta and shows header", () => {
  const s = play([
    {
      type: "event",
      event: event("task.created", { requirement: "r", pipeline: { name: "quick-fix" }, repoPath: "/r", branch: "b" }),
    },
  ]);
  assert.equal(s.meta.taskId, "t1");
  assert.equal(s.meta.pipeline, "quick-fix");
  assert.equal(s.meta.requirement, "r");
  assert.equal(s.headerShown, true);
  assert.equal(s.entries[0]!.kind, "header");
});

test("task.started → running with a status entry", () => {
  const s = play([{ type: "event", event: started }]);
  assert.equal(s.status, "running");
  assert.ok(s.startedAt);
  assert.equal(s.entries[0]!.kind, "status");
});

test("task.completed is terminal and clears pending", () => {
  const s = play([
    { type: "event", event: started },
    { type: "pending", request: { requestId: "r1", nodeId: "g", kind: "gate", summary: "s" } },
    { type: "event", event: event("task.completed", { branch: "main" }, 5) },
  ]);
  assert.equal(s.status, "completed");
  assert.equal(s.pending, null);
  assert.ok(s.finishedAt);
  assert.equal(s.entries.at(-1)!.kind, "status");
});

test("node.started sets activeNode with loopLabel", () => {
  const s = play([
    { type: "event", event: started },
    {
      type: "event",
      event: event("node.started", {
        nodeId: "code",
        primitive: "agent",
        engine: "coder",
        loopStack: [{ loopId: "reviewLoop", iteration: 2 }],
      }),
    },
  ]);
  assert.equal(s.activeNode?.nodeId, "code");
  assert.equal(s.activeNode?.engine, "coder");
  assert.equal(s.entries.at(-1)!.kind, "nodeStart");
});

test("stream chunks: multi-line text splits into entries, partial stays buffered", () => {
  let s = play([{ type: "event", event: started }]);
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "text", text: "line1\nline2\nline3" } }) });
  const kinds = s.entries.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "text").length, 2, "two complete lines logged");
  assert.equal(s.stream?.partial, "line3", "unfinished line buffered");

  // continuation completes the buffered line (stream remains, now empty)
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "text", text: " continued\n" } }) });
  assert.equal(s.stream?.partial, "", "stream buffer drained");
  const texts = s.entries.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
  assert.equal(texts.at(-1), "line3 continued");
});

test("stream chunks: blank line runs are collapsed", () => {
  let s = play([{ type: "event", event: started }]);
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "text", text: "a\n\n\n\nb\n" } }) });
  const texts = s.entries.filter((e) => e.kind === "text");
  assert.equal(texts.length, 3, "a, one blank, b");
});

test("stream kind switch flushes the previous buffer", () => {
  let s = play([{ type: "event", event: started }]);
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "text", text: "partial" } }) });
  assert.equal(s.stream?.kind, "text");
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "thinking", text: "hmm" } }) });
  assert.equal(s.stream?.kind, "thinking");
  const texts = s.entries.filter((e) => e.kind === "text");
  assert.equal(texts.at(-1)!.kind, "text");
});

test("toolUse and fileChange chunks bump counters", () => {
  let s = play([
    { type: "event", event: started },
    {
      type: "event",
      event: event("node.started", { nodeId: "code", primitive: "agent" }),
    },
  ]);
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "toolUse", tool: "Write", summary: "a.ts" } }) });
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "fileChange", path: "a.ts", op: "edit" } }) });
  assert.equal(s.counters.tools, 1);
  assert.equal(s.counters.files, 1);
  assert.equal(s.activeNode?.tools, 1);
  assert.equal(s.activeNode?.files, 1);
  assert.equal(s.activeNode?.lastTool, "Write");
});

test("engine.turn.completed accumulates usage", () => {
  const s = play([
    { type: "event", event: started },
    {
      type: "event",
      event: event("engine.turn.completed", { usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.1 } }),
    },
    {
      type: "event",
      event: event("engine.turn.completed", { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }),
    },
  ]);
  assert.equal(s.counters.turns, 2);
  assert.equal(s.counters.inputTokens, 110);
  assert.equal(s.counters.outputTokens, 55);
  assert.equal(s.counters.costUsd, 0.11);
});

test("loop.iteration updates loopStack and loopMax", () => {
  const s = play([
    { type: "event", event: event("loop.iteration", { loopId: "planLoop", iteration: 1, maxIterations: 3 }) },
    { type: "event", event: event("loop.iteration", { loopId: "planLoop", iteration: 2, maxIterations: 3 }) },
  ]);
  assert.equal(s.loopStack.length, 1);
  assert.equal(s.loopStack[0]!.iteration, 2);
  assert.equal(s.loopMax.planLoop, 3);
});

test("intervention.required parks pending and suspends", () => {
  const s = play([
    { type: "event", event: started },
    {
      type: "event",
      event: event("intervention.required", { requestId: "r1", nodeId: "planGate", kind: "gate", summary: "ok?" }),
    },
  ]);
  assert.equal(s.status, "suspended");
  assert.equal(s.pending?.requestId, "r1");
  assert.equal(s.pendingBusy, false);
});

test("intervention.required duplicate requestId keeps state but logs each event", () => {
  let s = play([{ type: "event", event: started }]);
  const reqEvent: UiAction = { type: "event", event: event("intervention.required", { requestId: "r1", nodeId: "g", kind: "gate", summary: "s" }) };
  s = reduce(s, reqEvent);
  s = reduce(s, reqEvent);
  // state is not re-parked (no busy reset), but the replay entry is logged
  assert.equal(s.pending?.requestId, "r1");
  assert.equal(s.pendingBusy, false);
  const interventions = s.entries.filter((e) => e.kind === "intervention");
  assert.equal(interventions.length, 2);
});

test("submitStart/Error/Done lifecycle on the pending panel", () => {
  let s = play([
    { type: "event", event: started },
    { type: "event", event: event("intervention.required", { requestId: "r1", nodeId: "g", kind: "gate", summary: "s" }) },
  ]);
  s = reduce(s, { type: "submitStart", requestId: "r1" });
  assert.equal(s.pendingBusy, true);
  s = reduce(s, { type: "submitError", requestId: "r1", message: "network" });
  assert.equal(s.pendingBusy, false);
  assert.equal(s.pendingError, "network");
  s = reduce(s, { type: "submitDone", requestId: "r1" });
  assert.equal(s.pending, null);
  assert.equal(s.resolvedRequestIds["r1"], true);
});

test("intervention.resolved clears pending and returns to running", () => {
  let s = play([
    { type: "event", event: started },
    { type: "event", event: event("intervention.required", { requestId: "r1", nodeId: "g", kind: "gate", summary: "s" }) },
    { type: "event", event: event("intervention.resolved", { requestId: "r1", decision: { action: "approve" } }) },
  ]);
  assert.equal(s.status, "running");
  assert.equal(s.pending, null);
  assert.equal(s.resolvedRequestIds["r1"], true);
});

test("review.completed logs a review entry", () => {
  const s = play([
    {
      type: "event",
      event: event("review.completed", {
        comments: [{ id: "c1", severity: "major", comment: "x", status: "open" }],
        passed: false,
      }),
    },
  ]);
  assert.equal(s.entries.at(-1)!.kind, "review");
});

test("git.commit bumps the commit counter", () => {
  const s = play([{ type: "event", event: event("git.commit", { sha: "abc1234", message: "feat: x" }) }]);
  assert.equal(s.counters.commits, 1);
  assert.equal(s.entries.at(-1)!.kind, "commit");
});

test("finish with unchanged status adds no extra entry", () => {
  let s = play([
    { type: "event", event: started },
    { type: "event", event: event("task.completed", {}) },
  ]);
  const before = s.entries.filter((e) => e.kind === "status").length;
  s = reduce(s, { type: "finish", status: "completed" });
  const after = s.entries.filter((e) => e.kind === "status").length;
  assert.equal(after, before, "finish must not duplicate the status entry");
  assert.equal(s.status, "completed");

  s = play([{ type: "finish", status: "failed", error: "boom" }]);
  assert.equal(s.status, "failed");
  assert.equal(s.error, "boom");
});

test("notice appends and flushes stream", () => {
  let s = play([{ type: "event", event: started }]);
  s = reduce(s, { type: "event", event: event("engine.chunk", { chunk: { kind: "text", text: "half" } }) });
  s = reduce(s, { type: "notice", level: "warn", text: "careful" });
  assert.equal(s.entries.at(-1)!.kind, "notice");
  const texts = s.entries.filter((e) => e.kind === "text");
  assert.equal(texts.at(-1)!.kind, "text");
});

test("task.suspended clears activeNode", () => {
  let s = play([
    { type: "event", event: started },
    { type: "event", event: event("node.started", { nodeId: "plan", primitive: "agent" }) },
    { type: "event", event: event("task.suspended", { reason: "limit" }) },
  ]);
  assert.equal(s.status, "suspended");
  assert.equal(s.activeNode, undefined);
});

test("task.resumed resets pending state", () => {
  let s = play([
    { type: "event", event: started },
    { type: "event", event: event("intervention.required", { requestId: "r1", nodeId: "g", kind: "gate", summary: "s" }) },
    { type: "event", event: event("task.resumed", { nodeId: "planGate", flowIndex: 1 }) },
  ]);
  assert.equal(s.status, "running");
  assert.equal(s.pending, null);
  assert.equal(s.pendingBusy, false);
  assert.deepEqual(s.resolvedRequestIds, {});
});
