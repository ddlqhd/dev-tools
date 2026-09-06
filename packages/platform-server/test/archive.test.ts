import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_AFTER_MS, PlatformStore, type TaskRow } from "../src/db/store.js";

function taskRow(id: string, over: Partial<TaskRow> = {}): TaskRow {
  const now = new Date().toISOString();
  return {
    id,
    repo_id: "r1",
    source: "manual",
    issue_number: null,
    title: `task ${id}`,
    requirement: "req",
    status: "queued",
    priority: 0,
    instance_id: null,
    kernel_task_id: null,
    branch: null,
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

function withStore(run: (store: PlatformStore) => void): Promise<void> {
  return mkdtemp(join(tmpdir(), "codeloop-archive-")).then((tmp) => {
    const store = new PlatformStore(tmp);
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });
    try {
      run(store);
    } finally {
      store.close();
    }
  });
}

test("listTasks: 默认排除已归档", async () => {
  await withStore((store) => {
    store.insertTask(taskRow("open"));
    store.insertTask(taskRow("old", { status: "done" }));
    store.setTaskArchived("old", true);
    const listed = store.listTasks();
    assert.deepEqual(listed.map((t) => t.id), ["open"]);
    assert.equal(store.listTasks({ includeArchived: true }).length, 2);
  });
});

test("archiveStaleTerminals: 只收 30 天未更新的终态", async () => {
  await withStore((store) => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const stale = new Date(now.getTime() - ARCHIVE_AFTER_MS - 1000).toISOString();
    const fresh = new Date(now.getTime() - ARCHIVE_AFTER_MS + 60_000).toISOString();
    store.insertTask(taskRow("stale-done", { status: "done", updated_at: stale, created_at: stale }));
    store.insertTask(taskRow("fresh-done", { status: "done", updated_at: fresh, created_at: fresh }));
    store.insertTask(taskRow("stale-run", { status: "running", updated_at: stale, created_at: stale }));
    const swept = store.archiveStaleTerminals(now);
    assert.deepEqual(swept.map((t) => t.id), ["stale-done"]);
    assert.equal(store.getTask("stale-done")?.archived_at, now.toISOString());
    assert.equal(store.getTask("fresh-done")?.archived_at ?? null, null);
    assert.equal(store.getTask("stale-run")?.archived_at ?? null, null);
    assert.deepEqual(store.listTasks().map((t) => t.id).sort(), ["fresh-done", "stale-run"]);
  });
});

test("setTaskArchived: 取消归档后重新出现在默认列表", async () => {
  await withStore((store) => {
    store.insertTask(taskRow("t1", { status: "failed" }));
    store.setTaskArchived("t1", true);
    assert.equal(store.listTasks().length, 0);
    store.setTaskArchived("t1", false);
    assert.equal(store.listTasks()[0]?.id, "t1");
    assert.equal(store.listTasks()[0]?.archived_at ?? null, null);
  });
});

test("setTaskArchived: 拒绝归档非终态", async () => {
  await withStore((store) => {
    store.insertTask(taskRow("run", { status: "running" }));
    assert.throws(() => store.setTaskArchived("run", true), /only terminal tasks/);
    assert.equal(store.getTask("run")?.archived_at ?? null, null);
  });
});
