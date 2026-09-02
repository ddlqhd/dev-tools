import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelEvent } from "@devtools/shared";
import type { RepoRow, TaskEventRow, TaskRow } from "./db/store.js";
import type { PlatformStore } from "./db/store.js";
import { KernelClient } from "./kernel-client.js";

/** Prefer the kernel's full log (includes engine.chunk); fall back to jsonl, then the store. */
export async function listTaskEvents(
  store: PlatformStore,
  task: TaskRow,
  repo: RepoRow | null,
  after = 0,
): Promise<TaskEventRow[]> {
  if (task.instance_id && task.kernel_task_id) {
    const inst = store.getInstance(task.instance_id);
    if (inst) {
      try {
        const events = await new KernelClient(inst.endpoint, inst.token).events(
          task.kernel_task_id,
          after,
        );
        return events.map((event) => toRow(task.id, event));
      } catch {
        // instance idle/dead — try the on-disk log
      }
    }
  }
  if (repo?.clone_path && task.kernel_task_id) {
    const fromDisk = await readEventJsonl(repo.clone_path, task.kernel_task_id, task.id, after);
    if (fromDisk) return fromDisk;
  }
  return store.listEvents(task.id, after);
}

async function readEventJsonl(
  repoPath: string,
  kernelTaskId: string,
  taskId: string,
  after: number,
): Promise<TaskEventRow[] | undefined> {
  const path = join(repoPath, ".codeloop", "tasks", kernelTaskId, "events.jsonl");
  try {
    const raw = await readFile(path, "utf8");
    const rows: TaskEventRow[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as KernelEvent;
        if (event.seq > after) rows.push(toRow(taskId, event));
      } catch {
        // skip a corrupt line
      }
    }
    return rows;
  } catch {
    return undefined;
  }
}

function toRow(taskId: string, event: KernelEvent): TaskEventRow {
  return {
    task_id: taskId,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    payload: JSON.stringify(event.payload ?? {}),
  };
}
