import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  mergeRemoteTaskDetail,
  parseStoredKernelEvents,
  type KernelEvent,
  type TaskDetail,
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
  assert.deepEqual(
    detail.workflow.steps.map((s) => (s.kind === "node" ? s.node.nodeId : s.loop.loopId)),
    ["plan", "code"],
  );
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

test("buildTaskDetail: empty log + flow still yields a pending workflow", () => {
  const detail = buildTaskDetail(
    source({
      status: "running",
      pipeline: {
        name: "p",
        hash: "h",
        flow: [{ kind: "node", nodeId: "plan" }],
        nodes: { plan: { type: "agent", engine: "planner" } },
      },
    }),
    [],
  );
  assert.equal(detail.stages.length, 0);
  assert.equal(detail.workflow.steps.length, 1);
  assert.equal(detail.workflow.steps[0]!.kind, "node");
  if (detail.workflow.steps[0]!.kind !== "node") throw new Error("expected node");
  assert.equal(detail.workflow.steps[0].node.status, "pending");
});

function stubDetail(over: Partial<TaskDetail> & Pick<TaskDetail, "workflow" | "stages">): TaskDetail {
  return {
    taskId: "k1",
    requirement: "req",
    status: "running",
    currentNode: null,
    error: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    pipeline: { name: "p", hash: "" },
    git: { repoPath: "", worktreePath: "", branch: "", baseCommit: "" },
    artifacts: [],
    commits: [],
    interventions: [],
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    eventCount: 0,
    lastSeq: 0,
    ...over,
  };
}

test("mergeRemoteTaskDetail: keeps a remote graph even when stages are empty", () => {
  const remote = stubDetail({
    stages: [],
    workflow: {
      name: "p",
      steps: [{ kind: "node", node: { nodeId: "plan", primitive: "agent", status: "pending", runCount: 0 } }],
    },
  });
  const fallback = stubDetail({
    stages: [],
    workflow: { name: "p", steps: [] },
  });
  assert.equal(mergeRemoteTaskDetail(remote, fallback), remote);
});

test("mergeRemoteTaskDetail: attaches fallback workflow when remote omitted it", () => {
  const fallback = stubDetail({
    stages: [],
    workflow: {
      name: "p",
      steps: [{ kind: "node", node: { nodeId: "plan", primitive: "agent", status: "completed", runCount: 1 } }],
    },
  });
  const remote = stubDetail({
    stages: [
      {
        index: 1,
        nodeId: "plan",
        primitive: "agent",
        loopStack: [],
        nodeRun: 1,
        startedAt: "2026-08-23T00:00:00.000Z",
        status: "completed",
        artifacts: [],
        commits: [],
        interventions: [],
        toolUseCount: 0,
        filesChanged: [],
        retries: [],
        eventRange: { from: 1, to: 2 },
      },
    ],
    workflow: { name: "p", steps: [] },
  });
  const merged = mergeRemoteTaskDetail(remote, fallback);
  assert.equal(merged.stages.length, 1);
  assert.equal(merged.workflow.steps[0]!.kind, "node");
  if (merged.workflow.steps[0]!.kind !== "node") throw new Error("expected node");
  assert.equal(merged.workflow.steps[0].node.nodeId, "plan");
});
