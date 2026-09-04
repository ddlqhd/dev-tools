import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformConfig } from "../src/config.js";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { EventSync } from "../src/sync.js";

let tmp: string;

function makeConfig(over: Partial<PlatformConfig["scheduler"]> = {}): PlatformConfig {
  return {
    dataDir: tmp,
    reposCache: tmp,
    listen: { host: "127.0.0.1", port: 4800 },
    github: {},
    scheduler: {
      globalMaxInstances: 2,
      pollIntervalMs: 300_000,
      tickMs: 3_000,
      retry: { maxRetries: 2, baseDelayMs: 60_000 },
      ciFix: { enabled: true, maxPerTask: 3 },
      ...over,
    },
    codeloopBin: ["node", "/dev/null"],
    defaultBaseBranch: "main",
  } as unknown as PlatformConfig;
}

function makeSync(store: PlatformStore, cfg: PlatformConfig): EventSync {
  return new EventSync(
    store,
    cfg,
    {} as never,
    () => undefined,
    () => undefined,
  );
}

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

test("handleTaskFailure requeues with backoff until the budget is spent", async () => {
  tmp = await mkdtemp(join(tmpdir(), "codeloop-retry-"));
  const store = new PlatformStore(tmp);
  const sync = makeSync(store, makeConfig());
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.insertTask(taskRow("t1", { kernel_task_id: "k1" }));

    sync.handleTaskFailure("t1", "push failed: boom");
    let t = store.getTask("t1")!;
    assert.equal(t.status, "queued");
    assert.equal(t.retry_count, 1);
    assert.ok(t.next_retry_at);
    assert.equal(t.branch, null, "non-ci-fix tasks get a fresh branch on retry");
    assert.equal(t.kernel_task_id, null);

    // Not yet due: dequeue must skip it
    assert.equal(store.dequeueCandidates(10).find((x) => x.id === "t1"), undefined);

    // Second failure consumes the last retry (bound again after a successful re-dispatch)
    store.updateTask("t1", { status: "running", kernel_task_id: "k2" });
    sync.handleTaskFailure("t1", "PR failed: boom again");
    t = store.getTask("t1")!;
    assert.equal(t.status, "queued");
    assert.equal(t.retry_count, 2);

    // Third failure is terminal
    store.updateTask("t1", { status: "running", kernel_task_id: "k3" });
    sync.handleTaskFailure("t1", "still broken");
    t = store.getTask("t1")!;
    assert.equal(t.status, "failed");
    assert.match(t.error!, /still broken/);

    // Non-retryable errors fail immediately even with budget left
    store.insertTask(taskRow("t2", { branch: null, kernel_task_id: "k2" }));
    sync.handleTaskFailure("t2", "Budget exceeded: maxEngineCalls");
    assert.equal(store.getTask("t2")!.status, "failed");

    store.insertTask(taskRow("t3", { branch: null, kernel_task_id: "k3" }));
    sync.handleTaskFailure(
      "t3",
      "kernel createTask: 500 Missing engine config for: coder",
    );
    assert.equal(store.getTask("t3")!.status, "failed");

    // Never started: spawn / createTask must not sit in the queue
    store.insertTask(taskRow("t4", { status: "preparing", branch: null, kernel_task_id: null }));
    sync.handleTaskFailure("t4", "codeloop serve failed to spawn: spawn codeloop ENOENT");
    t = store.getTask("t4")!;
    assert.equal(t.status, "failed");
    assert.match(t.error!, /spawn codeloop ENOENT/);
    assert.equal(t.retry_count ?? 0, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    store.close();
  }
});

test("waiting_human does not consume repo concurrency slots; due retries are dequeued", async () => {
  tmp = await mkdtemp(join(tmpdir(), "codeloop-slot-"));
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.insertTask(taskRow("w1", { status: "waiting_human" }));
    assert.equal(store.countActiveByRepo("r1"), 0, "waiting_human must not block scheduling");

    const past = new Date(Date.now() - 1000).toISOString();
    store.insertTask(taskRow("due", { status: "queued", next_retry_at: past, branch: null }));
    const candidates = store.dequeueCandidates(10);
    assert.ok(candidates.some((t) => t.id === "due"), "past-due retry must be picked up");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    store.close();
  }
});

test("releaseInstance stays busy while another task is still bound", async () => {
  tmp = await mkdtemp(join(tmpdir(), "codeloop-release-"));
  const store = new PlatformStore(tmp);
  const sync = makeSync(store, makeConfig());
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 10,
      loop_config: null,
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
    store.insertTask(taskRow("keep", { instance_id: "inst-1", status: "running" }));
    store.insertTask(taskRow("done", { instance_id: "inst-1", status: "done" }));

    sync.releaseInstance("inst-1");
    assert.equal(store.getInstance("inst-1")!.status, "busy");

    store.updateTask("keep", { status: "done" });
    sync.releaseInstance("inst-1");
    assert.equal(store.getInstance("inst-1")!.status, "idle");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    store.close();
  }
});
