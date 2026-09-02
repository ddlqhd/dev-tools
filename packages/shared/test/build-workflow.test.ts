import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkflowView,
  countWorkflowNodes,
  type FlowStep,
  type NodeSpec,
  type StageExecution,
} from "../src/index.js";

function stage(over: Partial<StageExecution> & { nodeId: string }): StageExecution {
  return {
    index: over.index ?? 1,
    nodeId: over.nodeId,
    primitive: over.primitive ?? "agent",
    engine: over.engine,
    loopStack: over.loopStack ?? [],
    loopLabel: over.loopLabel,
    nodeRun: over.nodeRun ?? 1,
    startedAt: over.startedAt ?? "2026-08-23T00:00:00.000Z",
    durationMs: over.durationMs,
    status: over.status ?? "completed",
    artifacts: [],
    commits: [],
    interventions: [],
    toolUseCount: 0,
    filesChanged: [],
    retries: [],
    eventRange: { from: 1, to: 1 },
  };
}

const nodes: Record<string, NodeSpec> = {
  plan: { type: "agent", engine: "planner" },
  planReview: { type: "review", engine: "planReviewer" },
  code: { type: "agent", engine: "coder" },
};

const flow: FlowStep[] = [
  { kind: "loop", id: "planLoop", maxIterations: 3, body: ["plan", "planReview"], until: "planReview.passed" },
  { kind: "node", nodeId: "code" },
];

test("buildWorkflowView: overlays stages onto a defined flow", () => {
  const view = buildWorkflowView("default-codeloop", [
    stage({ index: 1, nodeId: "plan", engine: "planner", status: "completed", durationMs: 1200 }),
    stage({
      index: 2,
      nodeId: "plan",
      engine: "planner",
      status: "running",
      nodeRun: 2,
      loopStack: [{ loopId: "planLoop", iteration: 2 }],
    }),
  ], flow, nodes);

  assert.equal(view.name, "default-codeloop");
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0]!.kind, "loop");
  if (view.steps[0]!.kind !== "loop") throw new Error("expected loop");
  assert.equal(view.steps[0].loop.loopId, "planLoop");
  assert.equal(view.steps[0].loop.iteration, 2);
  assert.equal(view.steps[0].loop.body[0]!.status, "running");
  assert.equal(view.steps[0].loop.body[0]!.runCount, 2);
  assert.equal(view.steps[0].loop.body[1]!.status, "pending");
  assert.equal(view.steps[1]!.kind, "node");
  if (view.steps[1]!.kind !== "node") throw new Error("expected node");
  assert.equal(view.steps[1].node.nodeId, "code");
  assert.equal(view.steps[1].node.status, "pending");
  assert.equal(view.steps[1].node.engine, "coder");
  assert.equal(countWorkflowNodes(view), 3);
});

test("buildWorkflowView: loop re-entry uses the latest stage status", () => {
  const view = buildWorkflowView("p", [
    stage({ index: 1, nodeId: "code", status: "completed", nodeRun: 1 }),
    stage({ index: 2, nodeId: "code", status: "failed", nodeRun: 2, durationMs: 50 }),
  ], [{ kind: "node", nodeId: "code" }], { code: { type: "agent", engine: "coder" } });
  assert.equal(view.steps[0]!.kind, "node");
  if (view.steps[0]!.kind !== "node") throw new Error("expected node");
  assert.equal(view.steps[0].node.status, "failed");
  assert.equal(view.steps[0].node.runCount, 2);
  assert.equal(view.steps[0].node.durationMs, 50);
  assert.equal(view.steps[0].node.latestStageIndex, 2);
});

test("buildWorkflowView: empty stages still list every defined node as pending", () => {
  const view = buildWorkflowView("default-codeloop", [], flow, nodes);
  assert.equal(countWorkflowNodes(view), 3);
  assert.equal(view.steps[0]!.kind, "loop");
  if (view.steps[0]!.kind !== "loop") throw new Error("expected loop");
  assert.equal(view.steps[0].loop.body[0]!.status, "pending");
  assert.equal(view.steps[0].loop.body[0]!.runCount, 0);
  assert.equal(view.steps[1]!.kind, "node");
  if (view.steps[1]!.kind !== "node") throw new Error("expected node");
  assert.equal(view.steps[1].node.nodeId, "code");
  assert.equal(view.steps[1].node.status, "pending");
});

test("buildWorkflowView: without a definition, lists unique nodeIds in first-seen order", () => {
  const view = buildWorkflowView("p", [
    stage({ index: 1, nodeId: "plan", primitive: "agent" }),
    stage({ index: 2, nodeId: "code", primitive: "agent" }),
    stage({ index: 3, nodeId: "plan", primitive: "agent", nodeRun: 2 }),
  ]);
  assert.deepEqual(
    view.steps.map((s) => (s.kind === "node" ? s.node.nodeId : s.loop.loopId)),
    ["plan", "code"],
  );
  if (view.steps[0]!.kind !== "node") throw new Error("expected node");
  assert.equal(view.steps[0].node.runCount, 2);
  assert.equal(view.steps[0].node.status, "completed");
});
