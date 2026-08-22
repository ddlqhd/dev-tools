import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { buildPlatformTaskDetail } from "../src/task-detail.js";

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
    const now = "2026-08-23T00:00:00.000Z";
    const task: TaskRow = {
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
    };
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

    const detail = buildPlatformTaskDetail(task, store.getRepo("r1")!, store.listEvents("p1"));
    assert.equal(detail.stages.length, 1);
    assert.equal(detail.stages[0]!.nodeId, "plan");
    assert.equal(detail.stages[0]!.status, "completed");
    assert.equal(detail.status, "completed");
  } finally {
    store.db.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
