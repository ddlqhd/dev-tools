import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { KernelEvent } from "@devtools/shared";
import { freshRepo, cleanupRepo, makeStubState, STUB_PATH } from "./helpers.js";

process.env.CODELOOP_CURSOR_BIN = STUB_PATH;

const { createAndRunTask } = await import("@devtools/kernel");

const TIMEOUT_CONFIG =
  "version: 1\npipeline: default-codeloop\npipelineOverrides:\n  planGate:\n    timeout: 1s\n    timeoutPolicy: approve\n";

test("gate timeout with policy=approve auto-resolves and completes", { timeout: 60_000 }, async () => {
  const repo = await freshRepo({ configYaml: TIMEOUT_CONFIG });
  const state = await makeStubState({});
  process.env.CODELOOP_STUB_STATE = state;
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      requirement: "implement the stub feature",
      repoPath: repo,
      inplace: true,
      autoApproveGates: false,
      sandbox: false,
      onEvent: (e: KernelEvent) => seen.push(e),
      // Nobody answers the gate — only the 1s timeout can unblock it.
      onIntervention: async () => new Promise(() => {}),
    });
    assert.equal(result.status, "completed", result.error);

    const resolved = seen.find((e) => e.type === "intervention.resolved");
    assert.ok(resolved, "expected an intervention.resolved event");
    const decision = (resolved!.payload as { decision?: { action?: string; auto?: boolean } })
      .decision;
    assert.equal(decision?.action, "approve");
    assert.equal(decision?.auto, true);
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("gate edit decision writes planDoc back and approves", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  process.env.CODELOOP_STUB_STATE = state;
  try {
    const result = await createAndRunTask({
      requirement: "implement the stub feature",
      repoPath: repo,
      inplace: true,
      autoApproveGates: false,
      sandbox: false,
      onIntervention: async () => ({
        action: "edit",
        content: "# Edited plan\n\nhuman rewrote this",
      }),
    });
    assert.equal(result.status, "completed", result.error);

    const plan = await import("node:fs/promises").then((fs) =>
      fs
        .readFile(join(repo, ".codeloop", "tasks", result.taskId, "artifacts", "planDoc.md"), "utf8")
        .catch(() => null),
    );
    assert.ok(plan?.includes("human rewrote this"), "planDoc must contain the edited content");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});
