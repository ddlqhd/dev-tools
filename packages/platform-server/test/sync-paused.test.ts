import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, type TaskRow } from "../src/db/store.js";

function taskRow(id: string, over: Partial<TaskRow> = {}): TaskRow {
  const now = new Date().toISOString();
  return {
    id,
    repo_id: "r1",
    source: "manual",
    issue_number: null,
    title: `task ${id}`,
    requirement: "req",
    status: "paused",
    priority: 0,
    instance_id: null,
    kernel_task_id: null,
    branch: "codeloop/x",
    pr_number: null,
    current_node: null,
    loop_state: null,
    pipeline_name: null,
    progress_comment_id: null,
    error: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

test("paused does not consume repo concurrency; holds instance occupancy", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-paused-"));
  const store = new PlatformStore(tmp);
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });
    store.insertInstance({
      id: "inst-1",
      launcher: "local-process",
      repo_id: "r1",
      endpoint: "http://127.0.0.1:1",
      token: null,
      pid: 1,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });

    store.insertTask(taskRow("p1", { status: "paused" }));
    assert.equal(store.countActiveByRepo("r1"), 0, "paused must not block repo scheduling");

    store.updateTask("p1", { instance_id: "inst-1", kernel_task_id: "k1" });
    assert.ok(
      store.countActiveTasksOnInstance("inst-1") >= 1,
      "paused still occupies its bound instance",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
    store.close();
  }
});
