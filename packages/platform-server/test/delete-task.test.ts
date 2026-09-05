import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelRuntime } from "@devtools/kernel";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { purgePlatformTask } from "../src/delete-task.js";
import { EventSync } from "../src/sync.js";

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

test("store.deleteTask: cascades events, interventions, usage", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-del-store-"));
  const store = new PlatformStore(tmp);
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      loop_config: null,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });
    store.insertTask(taskRow("t1"));
    store.insertEvent({
      task_id: "t1",
      seq: 1,
      ts: now,
      type: "task.started",
      payload: "{}",
    });
    store.insertIntervention({
      id: "iv1",
      task_id: "t1",
      request_id: "req1",
      kind: "gate",
      decision: null,
      decided_by: null,
      channel: "web",
      created_at: now,
      decided_at: null,
    });
    store.insertUsage({
      task_id: "t1",
      stage: "plan",
      engine_type: "cursor",
      input_tokens: 1,
      output_tokens: 2,
      cost_usd: null,
      ts: now,
    });

    store.deleteTask("t1");

    assert.equal(store.getTask("t1"), undefined);
    assert.equal(store.listEvents("t1").length, 0);
    const iv = store.db
      .prepare(`SELECT COUNT(*) AS c FROM interventions WHERE task_id = ?`)
      .get("t1") as { c: number };
    assert.equal(iv.c, 0);
    const usage = store.db
      .prepare(`SELECT COUNT(*) AS c FROM usage_records WHERE task_id = ?`)
      .get("t1") as { c: number };
    assert.equal(usage.c, 0);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("purgePlatformTask: children before parent; hub emits each deletion", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-del-purge-"));
  const store = new PlatformStore(tmp);
  const hubEvents: Array<{ type: string; payload: unknown }> = [];
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      loop_config: null,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });
    store.insertTask(taskRow("parent"));
    store.insertTask(taskRow("child", { parent_task_id: "parent", source: "ci-fix" }));
    store.insertTask(
      taskRow("grandchild", { parent_task_id: "child", source: "ci-fix" }),
    );

    await purgePlatformTask(
      {
        store,
        sync: { releaseInstance() {} },
        hub: (e) => hubEvents.push(e),
        log: { warn() {} },
      },
      "parent",
    );

    assert.equal(store.getTask("parent"), undefined);
    assert.equal(store.getTask("child"), undefined);
    assert.equal(store.getTask("grandchild"), undefined);
    assert.deepEqual(
      hubEvents.map((e) => (e.payload as { id: string }).id),
      ["grandchild", "child", "parent"],
    );
    assert.ok(hubEvents.every((e) => e.type === "task.deleted"));
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("purgePlatformTask: healthy instance uses HTTP delete, not KernelRuntime.open", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-del-http-"));
  const clone = join(tmp, "repo");
  await mkdir(clone, { recursive: true });
  const store = new PlatformStore(tmp);
  const openMock = mock.method(KernelRuntime, "open", async () => {
    throw new Error("open should not be called when healthy");
  });
  let deleteCalled = false;
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("/tasks/kid-1") && !u.includes("/health")) {
      deleteCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: clone,
      trigger_label: "ai-dev",
      max_concurrency: 1,
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
      endpoint: "http://127.0.0.1:9",
      token: null,
      pid: 1,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });
    store.insertTask(
      taskRow("t1", {
        status: "running",
        instance_id: "inst-1",
        kernel_task_id: "kid-1",
      }),
    );

    await purgePlatformTask(
      {
        store,
        sync: { releaseInstance() {} },
        hub: () => {},
        log: { warn() {} },
      },
      "t1",
    );

    assert.equal(deleteCalled, true);
    assert.equal(openMock.mock.callCount(), 0);
    assert.equal(store.getTask("t1"), undefined);
  } finally {
    openMock.mock.restore();
    fetchMock.mock.restore();
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("purgePlatformTask: unhealthy instance opens KernelRuntime", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-del-rt-"));
  const clone = join(tmp, "repo");
  await mkdir(clone, { recursive: true });
  const store = new PlatformStore(tmp);
  let deletedKid: string | null = null;
  let closed = false;
  const openMock = mock.method(KernelRuntime, "open", async (repoPath: string) => {
    assert.equal(repoPath, clone);
    return {
      async deleteTask(taskId: string) {
        deletedKid = taskId;
      },
      close() {
        closed = true;
      },
    } as unknown as KernelRuntime;
  });
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/health")) {
      return new Response("down", { status: 503 });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: clone,
      trigger_label: "ai-dev",
      max_concurrency: 1,
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
      endpoint: "http://127.0.0.1:9",
      token: null,
      pid: 1,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });
    store.insertTask(
      taskRow("t1", {
        status: "running",
        instance_id: "inst-1",
        kernel_task_id: "kid-2",
      }),
    );

    await purgePlatformTask(
      {
        store,
        sync: { releaseInstance() {} },
        hub: () => {},
        log: { warn() {} },
      },
      "t1",
    );

    assert.equal(deletedKid, "kid-2");
    assert.equal(closed, true);
    assert.equal(store.getTask("t1"), undefined);
  } finally {
    openMock.mock.restore();
    fetchMock.mock.restore();
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("purgePlatformTask: missing task throws not-found", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-del-404-"));
  const store = new PlatformStore(tmp);
  try {
    await assert.rejects(
      () =>
        purgePlatformTask(
          {
            store,
            sync: { releaseInstance() {} },
            hub: () => {},
            log: { warn() {} },
          },
          "missing",
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "not found" &&
        (err as Error & { statusCode: number }).statusCode === 404,
    );
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("purgePlatformTask: deleteTask then releaseInstance marks busy instance idle", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codeloop-del-release-"));
  const store = new PlatformStore(dataDir);
  const cfg = {
    dataDir,
    reposCache: dataDir,
    listen: { host: "127.0.0.1", port: 4800 },
    github: {},
    scheduler: {
      globalMaxInstances: 2,
      pollIntervalMs: 300_000,
      tickMs: 3_000,
      retry: { maxRetries: 2, baseDelayMs: 60_000 },
      ciFix: { enabled: true, maxPerTask: 3 },
    },
    codeloopBin: ["node", "/dev/null"],
    defaultBaseBranch: "main",
  } as unknown as import("../src/config.js").PlatformConfig;
  const sync = new EventSync(store, cfg, {} as never, () => undefined, () => undefined);
  const order: string[] = [];

  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "local",
      full_name: "o/r",
      clone_path: "/tmp/x",
      trigger_label: "ai-dev",
      max_concurrency: 1,
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
      endpoint: "http://127.0.0.1:9",
      token: null,
      pid: 1,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });
    store.insertTask(
      taskRow("t1", {
        status: "running",
        instance_id: "inst-1",
        kernel_task_id: null,
      }),
    );

    await purgePlatformTask(
      {
        store,
        sync: {
          releaseInstance(instanceId) {
            assert.equal(
              store.getTask("t1"),
              undefined,
              "task row must be gone before releaseInstance",
            );
            order.push("release");
            sync.releaseInstance(instanceId);
          },
        },
        hub: () => {
          order.push("hub");
        },
        log: { warn() {} },
      },
      "t1",
    );

    assert.deepEqual(order, ["release", "hub"]);
    assert.equal(store.getInstance("inst-1")?.status, "idle");
    assert.equal(store.getTask("t1"), undefined);
  } finally {
    sync.stopAll();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
