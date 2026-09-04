import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireKernelInstance,
  adoptLockIntoStore,
  takeFirstAliveInstance,
} from "../src/acquire-instance.js";
import { PlatformStore, type InstanceRow } from "../src/db/store.js";
import type { InstanceHandle, InstanceLauncher } from "../src/launcher/local.js";

async function withStore(fn: (store: PlatformStore) => Promise<void>): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-acquire-"));
  const store = new PlatformStore(tmp);
  try {
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await fn(store);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    store.close();
  }
}

function instance(id: string, over: Partial<InstanceRow> = {}): InstanceRow {
  const now = new Date().toISOString();
  return {
    id,
    launcher: "local-process",
    repo_id: "r1",
    endpoint: `http://127.0.0.1:${id === "busy-1" ? 1 : 2}`,
    token: null,
    pid: 1,
    status: "idle",
    started_at: now,
    last_seen_at: now,
    ...over,
  };
}

test("listReusableInstances returns busy before idle", async () => {
  await withStore(async (store) => {
    store.insertInstance(instance("idle-1", { status: "idle", endpoint: "http://127.0.0.1:2" }));
    store.insertInstance(instance("busy-1", { status: "busy", endpoint: "http://127.0.0.1:1" }));
    assert.deepEqual(
      store.listReusableInstances("r1").map((r) => r.id),
      ["busy-1", "idle-1"],
    );
    assert.deepEqual(store.listReusableInstances("other"), []);
  });
});

test("takeFirstAliveInstance can recover when a dead idle is listed first", async () => {
  const dead: string[] = [];
  const picked = await takeFirstAliveInstance(
    [instance("idle-1"), instance("busy-1", { status: "busy" })],
    async (row) => row.id === "busy-1",
    async (row) => {
      dead.push(row.id);
    },
  );
  assert.equal(picked?.id, "busy-1");
  assert.deepEqual(dead, ["idle-1"]);
});

test("takeFirstAliveInstance skips a dead idle and keeps the live busy kernel", async () => {
  const dead: string[] = [];
  const picked = await takeFirstAliveInstance(
    [
      instance("busy-1", { status: "busy" }),
      instance("idle-1", { status: "idle" }),
    ],
    async (row) => row.id === "busy-1",
    async (row) => {
      dead.push(row.id);
    },
  );
  assert.equal(picked?.id, "busy-1");
  assert.deepEqual(dead, []);
});

test("takeFirstAliveInstance marks every dead candidate", async () => {
  const dead: string[] = [];
  const picked = await takeFirstAliveInstance(
    [instance("idle-1"), instance("busy-1", { status: "busy" })],
    async () => false,
    async (row) => {
      dead.push(row.id);
    },
  );
  assert.equal(picked, undefined);
  assert.deepEqual(dead, ["idle-1", "busy-1"]);
});

test("adoptLockIntoStore revives a matching endpoint instead of inserting", async () => {
  await withStore(async (store) => {
    store.insertInstance(
      instance("old", { status: "dead", endpoint: "http://127.0.0.1:56033", pid: 9 }),
    );
    const row = adoptLockIntoStore(store, "r1", {
      host: "127.0.0.1",
      port: 56033,
      token: "tok",
      pid: 14052,
    });
    assert.equal(row.id, "old");
    assert.equal(row.status, "busy");
    assert.equal(row.token, "tok");
    assert.equal(row.pid, 14052);
    assert.equal(store.listInstances().length, 1);
  });
});

test("acquireKernelInstance reuses a live busy kernel and does not spawn", async () => {
  await withStore(async (store) => {
    store.insertInstance(instance("idle-1", { status: "idle", endpoint: "http://127.0.0.1:2" }));
    store.insertInstance(instance("busy-1", { status: "busy", endpoint: "http://127.0.0.1:1" }));

    let launches = 0;
    const launcher: InstanceLauncher = {
      launch: async () => {
        launches += 1;
        throw new Error("should not spawn");
      },
      terminate: async () => undefined,
      probe: async () => "dead",
    };

    const row = await acquireKernelInstance({
      store,
      repoId: "r1",
      clonePath: "/tmp/x",
      live: new Map(),
      launcher,
      watch: () => undefined,
      globalMaxInstances: 2,
      health: async (endpoint) => endpoint === "http://127.0.0.1:1",
      readLock: async () => null,
    });
    assert.equal(row.id, "busy-1");
    assert.equal(launches, 0);
    assert.equal(store.getInstance("busy-1")!.status, "busy");
  });
});

test("acquireKernelInstance attaches via kernel.lock when spawn hits an existing daemon", async () => {
  await withStore(async (store) => {
    const launcher: InstanceLauncher = {
      launch: async () => {
        throw new Error("codeloop serve exited early with code 1 — Kernel already running at 127.0.0.1:56033 (pid 14052).");
      },
      terminate: async () => undefined,
      probe: async () => "dead",
    };

    const row = await acquireKernelInstance({
      store,
      repoId: "r1",
      clonePath: "/tmp/x",
      live: new Map<string, InstanceHandle>(),
      launcher,
      watch: () => undefined,
      globalMaxInstances: 2,
      health: async () => false,
      readLock: async () => ({
        host: "127.0.0.1",
        port: 56033,
        token: "from-lock",
        pid: 14052,
        startedAt: new Date().toISOString(),
      }),
    });
    assert.equal(row.endpoint, "http://127.0.0.1:56033");
    assert.equal(row.token, "from-lock");
    assert.equal(row.status, "busy");
  });
});
