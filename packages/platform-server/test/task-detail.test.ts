import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { buildPlatformTaskDetail } from "../src/task-detail.js";

function taskRow(over: Partial<TaskRow> = {}): TaskRow {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    id: "p1",
    repo_id: "r1",
    source: "manual",
    issue_number: null,
    title: "done task",
    requirement: "req",
    status: "done",
    priority: 0,
    instance_id: null,
    kernel_task_id: "k1",
    branch: "codeloop/x",
    pr_number: null,
    current_node: null,
    loop_state: null,
    pipeline_name: "default-codeloop",
    progress_comment_id: null,
    error: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

test("buildPlatformTaskDetail: completed unbound task still has stages", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-detail-"));
  const store = new PlatformStore(tmp);
  try {
    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      loop_config: null,
      github_token: null,
      default_branch: "main",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    const task = taskRow();
    store.insertTask(task);
    store.insertEvent({
      task_id: "p1",
      seq: 1,
      ts: "2026-08-23T00:00:01.000Z",
      type: "node.started",
      payload: JSON.stringify({ nodeId: "plan", primitive: "agent", loopStack: [] }),
    });
    store.insertEvent({
      task_id: "p1",
      seq: 2,
      ts: "2026-08-23T00:00:02.000Z",
      type: "node.completed",
      payload: JSON.stringify({ nodeId: "plan", outcome: {}, artifactIds: ["planDoc"] }),
    });
    store.insertEvent({
      task_id: "p1",
      seq: 3,
      ts: "2026-08-23T00:00:03.000Z",
      type: "task.completed",
      payload: "{}",
    });

    const detail = await buildPlatformTaskDetail(task, store.getRepo("r1")!, store.listEvents("p1"));
    assert.equal(detail.stages.length, 1);
    assert.equal(detail.stages[0]!.nodeId, "plan");
    assert.equal(detail.stages[0]!.status, "completed");
    assert.equal(detail.status, "completed");
    assert.ok(detail.workflow.steps.length > 0);
    const plan = detail.workflow.steps
      .flatMap((s) => (s.kind === "loop" ? s.loop.body : [s.node]))
      .find((n) => n.nodeId === "plan");
    assert.equal(plan?.status, "completed");
    assert.equal(plan?.runCount, 1);
  } finally {
    store.db.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

const SNAPSHOT_YAML = `version: 1
pipeline: snapshot-pipe
nodes:
  onlySnap:
    type: agent
    engine: planner
flow:
  - onlySnap
`;

const CURRENT_YAML = `version: 1
pipeline: default-codeloop
nodes:
  currentOnly:
    type: agent
    engine: coder
flow:
  - currentOnly
`;

test("buildPlatformTaskDetail: prefers pipeline.snapshot.yaml over current repo yaml", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-detail-"));
  const store = new PlatformStore(tmp);
  const repoPath = join(tmp, "repo");
  try {
    await mkdir(join(repoPath, ".codeloop", "tasks", "k1"), { recursive: true });
    await mkdir(join(repoPath, ".codeloop", "pipelines"), { recursive: true });
    await writeFile(join(repoPath, ".codeloop", "pipelines", "default-codeloop.yaml"), CURRENT_YAML);
    await writeFile(join(repoPath, ".codeloop", "tasks", "k1", "pipeline.snapshot.yaml"), SNAPSHOT_YAML);

    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "o/r",
      clone_path: repoPath,
      trigger_label: "ai-dev",
      max_concurrency: 1,
      loop_config: null,
      github_token: null,
      default_branch: "main",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    const task = taskRow({ status: "queued", current_node: null });
    store.insertTask(task);

    const detail = await buildPlatformTaskDetail(task, store.getRepo("r1")!, store.listEvents("p1"));
    assert.equal(detail.stages.length, 0);
    assert.equal(detail.workflow.steps.length, 1);
    assert.equal(detail.workflow.steps[0]!.kind, "node");
    if (detail.workflow.steps[0]!.kind !== "node") throw new Error("expected node");
    assert.equal(detail.workflow.steps[0].node.nodeId, "onlySnap");
    assert.equal(detail.workflow.steps[0].node.status, "pending");
  } finally {
    store.db.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
