import { randomUUID } from "node:crypto";
import { readKernelLock, type LockFile } from "@devtools/kernel";
import type { InstanceRow, PlatformStore } from "./db/store.js";
import { KernelClient } from "./kernel-client.js";
import type { InstanceHandle, InstanceLauncher } from "./launcher/local.js";

export async function takeFirstAliveInstance(
  candidates: InstanceRow[],
  isAlive: (row: InstanceRow) => Promise<boolean>,
  markDead: (row: InstanceRow) => Promise<void>,
): Promise<InstanceRow | undefined> {
  for (const row of candidates) {
    if (await isAlive(row)) return row;
    await markDead(row);
  }
  return undefined;
}

export function lockEndpoint(lock: Pick<LockFile, "host" | "port">): string {
  return `http://${lock.host}:${lock.port}`;
}

/** Bind a live kernel.lock to a store row (revive matching endpoint or insert). */
export function adoptLockIntoStore(
  store: PlatformStore,
  repoId: string,
  lock: Pick<LockFile, "host" | "port" | "token" | "pid">,
): InstanceRow {
  const endpoint = lockEndpoint(lock);
  const existing = store
    .listInstances()
    .find((i) => i.repo_id === repoId && i.endpoint === endpoint);
  const now = new Date().toISOString();
  if (existing) {
    store.updateInstance(existing.id, {
      status: "busy",
      token: lock.token ?? existing.token,
      pid: lock.pid,
      last_seen_at: now,
    });
    return store.getInstance(existing.id)!;
  }
  const id = `inst_${lock.port}_${Date.now().toString(36)}`;
  store.insertInstance({
    id,
    launcher: "local-process",
    repo_id: repoId,
    endpoint,
    token: lock.token ?? null,
    pid: lock.pid,
    status: "busy",
    started_at: now,
    last_seen_at: now,
  });
  return store.getInstance(id)!;
}

function markBusy(store: PlatformStore, id: string): InstanceRow {
  store.updateInstance(id, {
    status: "busy",
    last_seen_at: new Date().toISOString(),
  });
  return store.getInstance(id)!;
}

export async function acquireKernelInstance(opts: {
  store: PlatformStore;
  repoId: string;
  clonePath: string;
  live: Map<string, InstanceHandle>;
  launcher: InstanceLauncher;
  watch: (instanceId: string) => void;
  globalMaxInstances: number;
  readLock?: (repoPath: string) => Promise<LockFile | null>;
  health?: (endpoint: string, token?: string | null) => Promise<boolean>;
}): Promise<InstanceRow> {
  const health =
    opts.health ??
    ((endpoint, token) => new KernelClient(endpoint, token).health());
  const readLock = opts.readLock ?? readKernelLock;

  const probe = async (row: InstanceRow): Promise<boolean> => {
    const handle = opts.live.get(row.id);
    if (handle) return (await opts.launcher.probe(handle)) === "alive";
    return health(row.endpoint, row.token);
  };

  const markDead = async (row: InstanceRow): Promise<void> => {
    const handle = opts.live.get(row.id);
    if (handle) {
      await opts.launcher.terminate(handle).catch(() => undefined);
      opts.live.delete(row.id);
    }
    opts.store.updateInstance(row.id, { status: "dead" });
  };

  const adoptLock = async (): Promise<InstanceRow | undefined> => {
    const lock = await readLock(opts.clonePath);
    if (!lock) return undefined;
    const row = adoptLockIntoStore(opts.store, opts.repoId, lock);
    opts.watch(row.id);
    return row;
  };

  const alive = await takeFirstAliveInstance(
    opts.store.listReusableInstances(opts.repoId),
    probe,
    markDead,
  );
  if (alive) {
    const row = markBusy(opts.store, alive.id);
    opts.watch(row.id);
    return row;
  }

  const locked = await adoptLock();
  if (locked) return locked;

  if (opts.store.countActiveInstances() >= opts.globalMaxInstances) {
    throw new Error("no free kernel instance (globalMaxInstances reached)");
  }

  try {
    const spawned = await opts.launcher.launch({
      repoPath: opts.clonePath,
      token: randomUUID().replace(/-/g, "").slice(0, 24),
    });
    const now = new Date().toISOString();
    opts.store.insertInstance({
      id: spawned.id,
      launcher: "local-process",
      repo_id: opts.repoId,
      endpoint: spawned.endpoint,
      token: spawned.token ?? null,
      pid: spawned.pid,
      status: "busy",
      started_at: now,
      last_seen_at: now,
    });
    opts.live.set(spawned.id, spawned);
    const created = opts.store.getInstance(spawned.id)!;
    opts.watch(created.id);
    return created;
  } catch (err) {
    const recovered = await adoptLock();
    if (recovered) return recovered;
    throw err;
  }
}
