import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskActionsEnabled,
  type TaskActionContext,
  type TaskControlAction,
} from "../src/task-actions.js";

function enabledSet(ctx: TaskActionContext): Set<TaskControlAction> {
  const flags = taskActionsEnabled(ctx);
  return new Set(
    (Object.keys(flags) as TaskControlAction[]).filter((k) => flags[k]),
  );
}

function assertEnabled(
  ctx: TaskActionContext,
  expected: TaskControlAction[],
): void {
  assert.deepEqual(enabledSet(ctx), new Set(expected));
}

const cases: Array<{
  name: string;
  ctx: TaskActionContext;
  expected: TaskControlAction[];
}> = [
  {
    name: "queued unbound",
    ctx: { status: "queued", bound: false, kernelStatus: null, hasPendingIntervention: false },
    expected: ["cancel"],
  },
  {
    name: "preparing bound running",
    ctx: {
      status: "preparing",
      bound: true,
      kernelStatus: "running",
      hasPendingIntervention: false,
    },
    expected: ["cancel", "abort", "pause"],
  },
  {
    name: "running bound running",
    ctx: {
      status: "running",
      bound: true,
      kernelStatus: "running",
      hasPendingIntervention: false,
    },
    expected: ["cancel", "abort", "pause", "inject"],
  },
  {
    name: "running bound suspended (operator pause)",
    ctx: {
      status: "running",
      bound: true,
      kernelStatus: "suspended",
      hasPendingIntervention: false,
    },
    expected: ["cancel", "abort", "resume"],
  },
  {
    name: "waiting_human bound suspended with pending",
    ctx: {
      status: "waiting_human",
      bound: true,
      kernelStatus: "suspended",
      hasPendingIntervention: true,
    },
    expected: ["cancel", "abort", "pause", "approve", "reject", "edit"],
  },
  {
    name: "waiting_human bound null kernel",
    ctx: {
      status: "waiting_human",
      bound: true,
      kernelStatus: null,
      hasPendingIntervention: false,
    },
    expected: ["cancel", "abort", "pause", "inject"],
  },
  {
    name: "delivering bound completed",
    ctx: {
      status: "delivering",
      bound: true,
      kernelStatus: "completed",
      hasPendingIntervention: false,
    },
    expected: ["cancel", "abort"],
  },
  {
    name: "failed unbound",
    ctx: { status: "failed", bound: false, kernelStatus: null, hasPendingIntervention: false },
    expected: ["retry"],
  },
  {
    name: "cancelled unbound",
    ctx: {
      status: "cancelled",
      bound: false,
      kernelStatus: null,
      hasPendingIntervention: false,
    },
    expected: ["retry"],
  },
  {
    name: "done unbound",
    ctx: { status: "done", bound: false, kernelStatus: null, hasPendingIntervention: false },
    expected: [],
  },
  {
    name: "merged unbound",
    ctx: { status: "merged", bound: false, kernelStatus: null, hasPendingIntervention: false },
    expected: [],
  },
];

for (const c of cases) {
  test(`taskActionsEnabled: ${c.name}`, () => {
    assertEnabled(c.ctx, c.expected);
  });
}
