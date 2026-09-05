import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { publicLiveInstance } from "../src/public.js";

function taskRow(id: string, over: Partial<TaskRow> = {}): TaskRow {
  const now = new Date().toISOString();
  return {
    id,
    repo_id: "r1",
    source: "manual",
    issue_number: null,
    title: `task ${id}`,
    requirement: "req",
    status: "running",
    priority: 0,
    instance_id: "inst-1",
    kernel_task_id: null,
    branch: "codeloop/x",
    pr_number: null,
    current_node: "code",
    loop_state: null,
    pipeline_name: null,
    progress_comment_id: null,
    error: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

test("listLiveInstances: hides dead rows; lists bound active tasks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-instances-list-"));
  const store = new PlatformStore(tmp);
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "acme/app",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });
    store.insertInstance({
      id: "inst-live",
      launcher: "local-process",
      repo_id: "r1",
      endpoint: "http://127.0.0.1:1",
      token: "secret",
      pid: 42,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });
    store.insertInstance({
      id: "inst-dead",
      launcher: "local-process",
      repo_id: "r1",
      endpoint: "http://127.0.0.1:2",
      token: null,
      pid: null,
      status: "dead",
      started_at: now,
      last_seen_at: now,
    });
    store.insertTask(taskRow("t-run", { instance_id: "inst-live", status: "running" }));
    store.insertTask(taskRow("t-wait", { instance_id: "inst-live", status: "waiting_human" }));
    store.insertTask(taskRow("t-done", { instance_id: "inst-live", status: "done" }));
    store.insertTask(taskRow("t-other", { instance_id: "inst-dead", status: "running" }));

    const live = store.listLiveInstances();
    assert.deepEqual(
      live.map((row) => row.id),
      ["inst-live"],
    );

    const tasks = store.listTasksOnInstance("inst-live");
    assert.deepEqual(
      tasks.map((row) => row.id).sort(),
      ["t-run", "t-wait"],
    );

    const pub = publicLiveInstance(live[0]!, store.getRepo("r1"), tasks);
    assert.equal("token" in pub, false);
    assert.equal("repo_id" in pub, false);
    assert.deepEqual(pub.repo, { id: "r1", full_name: "acme/app" });
    assert.equal(pub.tasks.length, 2);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
