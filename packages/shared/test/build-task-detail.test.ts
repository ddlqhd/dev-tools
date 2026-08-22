import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  parseStoredKernelEvents,
  type KernelEvent,
  type TaskDetailSource,
} from "../src/index.js";

function source(over: Partial<TaskDetailSource> = {}): TaskDetailSource {
  return {
    taskId: "k1",
    requirement: "req",
    status: "completed",
    currentNode: null,
    error: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:10:00.000Z",
    pipeline: { name: "default-codeloop", hash: "abc" },
    git: {
      repoPath: "/repo",
      worktreePath: "/wt",
      branch: "codeloop/x",
      baseCommit: "base",
    },
    artifacts: [],
    pendingIntervention: null,
    ...over,
  };
}

function ev(seq: number, type: KernelEvent["type"], payload: unknown, ts = `2026-08-23T00:00:0${seq}.000Z`): KernelEvent {
  return { seq, taskId: "k1", ts, type, payload };
}

test("buildTaskDetail: folds node.started/completed into stages", () => {
  const detail = buildTaskDetail(source(), [
    ev(1, "task.started", {}),
    ev(2, "node.started", { nodeId: "plan", primitive: "agent", engine: "planner", loopStack: [] }),
    ev(3, "node.completed", { nodeId: "plan", outcome: { summary: "ok" }, artifactIds: ["planDoc"] }),
    ev(4, "node.started", { nodeId: "code", primitive: "agent", engine: "coder", loopStack: [] }),
    ev(5, "node.completed", { nodeId: "code", outcome: {}, artifactIds: [] }),
    ev(6, "task.completed", {}),
  ]);
  assert.equal(detail.stages.length, 2);
  assert.equal(detail.stages[0]!.nodeId, "plan");
  assert.equal(detail.stages[0]!.status, "completed");
  assert.equal(detail.stages[0]!.artifacts[0]!.key, "planDoc");
  assert.equal(detail.stages[1]!.nodeId, "code");
  assert.equal(detail.stages[1]!.status, "completed");
  assert.equal(detail.status, "completed");
  assert.ok((detail.durationMs ?? 0) >= 0);
});

test("buildTaskDetail: loop re-entry yields a second stage for the same node", () => {
  const detail = buildTaskDetail(source(), [
    ev(1, "node.started", {
      nodeId: "code",
      primitive: "agent",
      loopStack: [{ loopId: "reviewLoop", iteration: 1 }],
    }),
    ev(2, "node.completed", { nodeId: "code", outcome: {}, artifactIds: [] }),
    ev(3, "node.started", {
      nodeId: "code",
      primitive: "agent",
      loopStack: [{ loopId: "reviewLoop", iteration: 2 }],
    }),
    ev(4, "node.completed", { nodeId: "code", outcome: {}, artifactIds: [] }),
    ev(5, "task.completed", {}),
  ]);
  assert.equal(detail.stages.length, 2);
  assert.equal(detail.stages[0]!.nodeRun, 1);
  assert.equal(detail.stages[1]!.nodeRun, 2);
  assert.equal(detail.stages[1]!.loopLabel, "reviewLoop#2");
});

test("parseStoredKernelEvents + completed platform task still yields stages", () => {
  const events = parseStoredKernelEvents([
    {
      seq: 1,
      ts: "2026-08-23T00:00:01.000Z",
      type: "node.started",
      payload: JSON.stringify({ nodeId: "plan", primitive: "agent", loopStack: [] }),
      task_id: "p1",
    },
    {
      seq: 2,
      ts: "2026-08-23T00:00:02.000Z",
      type: "node.completed",
      payload: JSON.stringify({ nodeId: "plan", outcome: {}, artifactIds: [] }),
      task_id: "p1",
    },
    {
      seq: 3,
      ts: "2026-08-23T00:00:03.000Z",
      type: "task.completed",
      payload: "{}",
      task_id: "p1",
    },
  ]);
  const detail = buildTaskDetail(source({ status: kernelStatusFromPlatform("done") }), events);
  assert.equal(detail.stages.length, 1);
  assert.equal(detail.stages[0]!.status, "completed");
  assert.equal(kernelStatusFromPlatform("done"), "completed");
  assert.equal(kernelStatusFromPlatform("cancelled"), "aborted");
});
