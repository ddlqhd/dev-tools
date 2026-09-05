import { existsSync } from "node:fs";
import { KernelRuntime } from "@devtools/kernel";
import type { PlatformStore } from "./db/store.js";
import { KernelClient } from "./kernel-client.js";

export interface PurgePlatformTaskDeps {
  store: PlatformStore;
  sync: { releaseInstance(instanceId: string | null | undefined): void };
  hub: (event: { type: string; payload: unknown }) => void;
  log: { warn(obj: unknown, msg?: string): void };
}

export async function purgePlatformTask(
  deps: PurgePlatformTaskDeps,
  id: string,
): Promise<void> {
  const { store, sync, hub, log } = deps;
  const task = store.getTask(id);
  if (!task) {
    const err = new Error("not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  for (const child of store.listChildTasks(id)) {
    await purgePlatformTask(deps, child.id);
  }

  const kid = task.kernel_task_id;
  if (kid) {
    const repo = store.getRepo(task.repo_id);
    if (repo?.clone_path && existsSync(repo.clone_path)) {
      const inst = task.instance_id ? store.getInstance(task.instance_id) : undefined;
      if (inst) {
        const client = new KernelClient(inst.endpoint, inst.token);
        if (await client.health()) {
          await client.delete(kid).catch((err) => {
            log.warn({ err }, "kernel HTTP delete failed");
          });
        } else {
          await deleteViaRuntime(repo.clone_path, kid, log);
        }
      } else {
        await deleteViaRuntime(repo.clone_path, kid, log);
      }
    }
  }

  const instanceId = task.instance_id;
  store.deleteTask(id);
  sync.releaseInstance(instanceId);
  hub({ type: "task.deleted", payload: { id } });
}

async function deleteViaRuntime(
  clonePath: string,
  kernelTaskId: string,
  log: PurgePlatformTaskDeps["log"],
): Promise<void> {
  const rt = await KernelRuntime.open(clonePath);
  try {
    await rt.deleteTask(kernelTaskId);
  } catch (err) {
    log.warn({ err }, "kernel runtime delete failed");
  } finally {
    rt.close();
  }
}
