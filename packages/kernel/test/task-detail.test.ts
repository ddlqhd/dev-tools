import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventLog } from "../src/store/index.js";
import { KernelRuntime } from "../src/runtime/kernel-runtime.js";
import { loadTaskDetail } from "../src/server/task-detail.js";
import { cleanupRepo, freshRepo } from "./helpers.js";

const PIPELINE_YAML = `version: 1
pipeline: plan-only
nodes:
  plan:
    type: agent
    engine: planner
    outputs: [planDoc]
flow:
  - plan
`;

test("loadTaskDetail: offline fold includes paths, artifact path, and stages", async () => {
  const repo = await freshRepo();
  const taskId = "abcd1234";
  const now = "2026-09-05T00:00:00.000Z";
  const planPath = join(repo, ".codeloop", "tasks", taskId, "artifacts", "planDoc.md");
  try {
    const runtime = await KernelRuntime.open(repo);
    runtime.store.insertTask({
      id: taskId,
      requirement: "do the thing",
      repo_path: repo,
      worktree_path: repo,
      branch: "codeloop/abcd1234",
      base_commit: "abc",
      pipeline_name: "plan-only",
      pipeline_hash: "h",
      status: "failed",
      current_node: "plan",
      loop_state: null,
      error: "boom",
      created_at: now,
      updated_at: now,
    });
    const dirs = await runtime.store.ensureTaskDirs(taskId);
    await writeFile(join(dirs.taskDir, "pipeline.snapshot.yaml"), PIPELINE_YAML, "utf8");
    await writeFile(join(dirs.artifactsDir, "planDoc.md"), "# Plan\n", "utf8");
    const log = await EventLog.open(taskId, dirs.taskDir);
    await log.emit("task.started", {});
    await log.emit("node.started", { nodeId: "plan", primitive: "agent", loopStack: [] });
    await log.emit("artifact.created", {
      artifactId: "planDoc",
      key: "planDoc",
      kind: "markdown",
      path: planPath,
    });
    await log.emit("node.completed", { nodeId: "plan", outcome: { summary: "ok" }, artifactIds: ["planDoc"] });
    await log.emit("task.failed", { error: "boom" });
    runtime.close();

    const { detail, events } = await loadTaskDetail(repo, taskId);
    assert.equal(detail.taskId, taskId);
    assert.equal(detail.status, "failed");
    assert.equal(detail.requirement, "do the thing");
    assert.equal(detail.error, "boom");
    assert.equal(detail.paths.taskDir, dirs.taskDir);
    assert.equal(detail.paths.artifactsDir, dirs.artifactsDir);
    assert.equal(detail.paths.eventsPath, join(dirs.taskDir, "events.jsonl"));
    assert.equal(detail.paths.worktreePath, repo);
    assert.equal(detail.paths.pipelineSnapshot, join(dirs.taskDir, "pipeline.snapshot.yaml"));
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0]!.key, "planDoc");
    assert.equal(detail.artifacts[0]!.path, planPath);
    assert.equal(detail.artifacts[0]!.producedByNodeId, "plan");
    assert.equal(detail.stages.length, 1);
    assert.equal(detail.stages[0]!.nodeId, "plan");
    assert.equal(detail.git.worktreePath, repo);
    assert.ok(events.length >= 5);
  } finally {
    await cleanupRepo(repo);
  }
});

test("loadTaskDetail: missing task throws", async () => {
  const repo = await freshRepo();
  try {
    await assert.rejects(() => loadTaskDetail(repo, "missing1"), /not found/i);
  } finally {
    await cleanupRepo(repo);
  }
});
