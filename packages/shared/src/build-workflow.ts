import type { LoopStackEntry } from "./events.js";
import { resolveNodeEngineKey, type FlowStep, type NodeSpec } from "./pipeline.js";
import type { StageStatus, WorkflowNodeView, WorkflowStepView, WorkflowView } from "./task-detail.js";

/** Fields needed to overlay status onto the pipeline graph. */
export type WorkflowStageInput = {
  index: number;
  nodeId: string;
  primitive: string;
  engine?: string;
  status: StageStatus;
  nodeRun: number;
  durationMs?: number;
  loopStack?: LoopStackEntry[];
};

/**
 * Overlay execution stages onto the pipeline graph. Without a definition,
 * fall back to unique nodeIds in first-appearance order.
 */
export function buildWorkflowView(
  name: string,
  stages: WorkflowStageInput[],
  flow?: FlowStep[],
  nodes?: Record<string, NodeSpec>,
): WorkflowView {
  if (flow?.length && nodes) {
    return {
      name,
      steps: flow.map((step) => toStep(step, nodes, stages)),
    };
  }
  return { name, steps: fallbackSteps(stages) };
}

export function countWorkflowNodes(workflow: WorkflowView): number {
  return workflow.steps.reduce(
    (n, step) => n + (step.kind === "loop" ? step.loop.body.length : 1),
    0,
  );
}

function toStep(
  step: FlowStep,
  nodes: Record<string, NodeSpec>,
  stages: WorkflowStageInput[],
): WorkflowStepView {
  if (step.kind === "loop") {
    return {
      kind: "loop",
      loop: {
        loopId: step.id,
        maxIterations: step.maxIterations,
        until: step.until,
        iteration: loopIteration(step.id, stages),
        body: step.body.map((nodeId) => overlayNode(nodeId, nodes[nodeId], stages)),
      },
    };
  }
  return { kind: "node", node: overlayNode(step.nodeId, nodes[step.nodeId], stages) };
}

function fallbackSteps(stages: WorkflowStageInput[]): WorkflowStepView[] {
  const seen = new Set<string>();
  const steps: WorkflowStepView[] = [];
  for (const stage of stages) {
    if (seen.has(stage.nodeId)) continue;
    seen.add(stage.nodeId);
    steps.push({ kind: "node", node: overlayNode(stage.nodeId, undefined, stages) });
  }
  return steps;
}

function overlayNode(
  nodeId: string,
  spec: NodeSpec | undefined,
  stages: WorkflowStageInput[],
): WorkflowNodeView {
  const nodeStages = stages.filter((s) => s.nodeId === nodeId);
  const latest = nodeStages[nodeStages.length - 1];
  return {
    nodeId,
    primitive: spec?.type ?? latest?.primitive ?? "agent",
    engine: latest?.engine ?? (spec ? resolveNodeEngineKey(spec) : undefined),
    status: latest?.status ?? "pending",
    runCount: nodeStages.length,
    latestStageIndex: latest?.index,
    durationMs: latest?.durationMs,
  };
}

function loopIteration(loopId: string, stages: WorkflowStageInput[]): number | undefined {
  let max: number | undefined;
  for (const stage of stages) {
    const entry = stage.loopStack?.find((l) => l.loopId === loopId);
    if (!entry) continue;
    max = max == null ? entry.iteration : Math.max(max, entry.iteration);
  }
  return max;
}
