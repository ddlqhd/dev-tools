import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDetail,
  inferTaskPaths,
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
  assert.equal(kernelStatusFromPlatform("paused"), "suspended");
});

test("buildTaskDetail: engine.turn.completed accumulates tokens and turns", () => {
  const detail = buildTaskDetail(source(), [
    ev(1, "node.started", { nodeId: "plan", primitive: "agent", loopStack: [] }),
    ev(2, "engine.turn.completed", {
      nodeId: "plan",
      usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.01 },
    }),
    ev(3, "engine.turn.completed", {
      nodeId: "plan",
      usage: { inputTokens: 20, outputTokens: 10 },
    }),
    ev(4, "node.completed", { nodeId: "plan", outcome: {}, artifactIds: [] }),
  ]);
  assert.deepEqual(detail.usage, { inputTokens: 120, outputTokens: 50, turns: 2, costUsd: 0.01 });
  assert.deepEqual(detail.stages[0]!.usage, {
    inputTokens: 120,
    outputTokens: 50,
    turns: 2,
    costUsd: 0.01,
  });
});

test("buildTaskDetail: fills git.worktreePath from task.created when source omitted it", () => {
  const detail = buildTaskDetail(
    source({
      git: { repoPath: "/repo", worktreePath: "", branch: "", baseCommit: "" },
      paths: inferTaskPaths("/repo", "k1", ""),
    }),
    [
      ev(1, "task.created", {
        requirement: "req",
        pipeline: { name: "default-codeloop", hash: "abc" },
        repoPath: "/repo",
        branch: "codeloop/k1",
        worktreePath: "/repo/.codeloop/worktrees/k1",
        inplace: false,
      }),
    ],
  );
  assert.equal(detail.git.worktreePath, "/repo/.codeloop/worktrees/k1");
  assert.equal(detail.git.branch, "codeloop/k1");
  assert.equal(detail.paths.worktreePath, "/repo/.codeloop/worktrees/k1");
});

test("buildTaskDetail: keeps artifact path and infers task layout paths", () => {
  const detail = buildTaskDetail(
    source({
      artifacts: [
        {
          key: "planDoc",
          ext: "md",
          size: 12,
          mtime: "2026-08-23T00:00:02.000Z",
          path: "/repo/.codeloop/tasks/k1/artifacts/planDoc.md",
        },
      ],
    }),
    [
      ev(1, "node.started", { nodeId: "plan", primitive: "agent", loopStack: [] }),
      ev(2, "artifact.created", { artifactId: "planDoc", key: "planDoc", kind: "md", path: "planDoc.md" }),
      ev(3, "node.completed", { nodeId: "plan", outcome: {}, artifactIds: ["planDoc"] }),
    ],
  );
  assert.equal(detail.artifacts[0]!.path, "/repo/.codeloop/tasks/k1/artifacts/planDoc.md");
  assert.equal(detail.artifacts[0]!.producedByNodeId, "plan");
  assert.equal(detail.paths.taskDir, "/repo/.codeloop/tasks/k1");
  assert.equal(detail.paths.artifactsDir, "/repo/.codeloop/tasks/k1/artifacts");
  assert.equal(detail.paths.eventsPath, "/repo/.codeloop/tasks/k1/events.jsonl");
  assert.equal(detail.paths.worktreePath, "/wt");
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
    paths: {
      taskDir: "/repo/.codeloop/tasks/k1",
      artifactsDir: "/repo/.codeloop/tasks/k1/artifacts",
      eventsPath: "/repo/.codeloop/tasks/k1/events.jsonl",
      worktreePath: "",
      pipelineSnapshot: "/repo/.codeloop/tasks/k1/pipeline.snapshot.yaml",
    },
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

test("mergeRemoteTaskDetail: fills empty worktree from the event-folded fallback", () => {
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
    git: { repoPath: "/repo", worktreePath: "/wt", branch: "codeloop/k1", baseCommit: "" },
    paths: { ...stubDetail({ stages: [], workflow: { name: "p", steps: [] } }).paths, worktreePath: "/wt" },
  });
  const merged = mergeRemoteTaskDetail(remote, fallback);
  assert.equal(merged.git.worktreePath, "/wt");
  assert.equal(merged.paths.worktreePath, "/wt");
});
