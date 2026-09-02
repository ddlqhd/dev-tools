import { useCallback, useEffect, useState } from "react";
import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  mergeRemoteTaskDetail,
  parseStoredKernelEvents,
} from "@devtools/shared";
import {
  api,
  connectHub,
  type KernelTaskSnapshot,
  type Repo,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from "./api";

export function detailFromEvents(task: Task, repo: Repo | null, events: TaskEvent[]): TaskDetail {
  return buildTaskDetail(
    {
      taskId: task.kernel_task_id ?? task.id,
      requirement: task.requirement,
      status: kernelStatusFromPlatform(task.status),
      currentNode: task.current_node,
      error: task.error,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      pipeline: { name: task.pipeline_name ?? "", hash: "" },
      git: {
        repoPath: repo?.clone_path ?? "",
        worktreePath: "",
        branch: task.branch ?? "",
        baseCommit: "",
      },
      artifacts: [],
      pendingIntervention: null,
    },
    parseStoredKernelEvents(events),
  );
}

export function useTaskLive(id: string) {
  const [task, setTask] = useState<Task | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [kernel, setKernel] = useState<KernelTaskSnapshot | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const info = await api.getTask(id);
    setTask(info.task);
    setRepo(info.repo);
    setKernel(info.kernel);
    const ev = await api.listEvents(id);
    setEvents(ev.events);
    const fallback = detailFromEvents(info.task, info.repo, ev.events);
    try {
      const d = await api.getDetail(id);
      setDetail(mergeRemoteTaskDetail(d.detail, fallback));
    } catch {
      setDetail(fallback);
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void reload().catch((e: Error) => setError(e.message));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDetail = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reload().catch(() => undefined);
      }, 400);
    };

    const off = connectHub((msg) => {
      if (msg.type === "task.updated") {
        const t = msg.payload as Task;
        if (t.id === id) {
          setTask(t);
          scheduleDetail();
        }
      }
      if (msg.type === "task.event") {
        const p = msg.payload as {
          taskId: string;
          event?: { type?: string; seq?: number; ts?: string; payload?: unknown };
        };
        if (p.taskId !== id) return;
        if (p.event?.seq != null && p.event.type) {
          const row: TaskEvent = {
            task_id: id,
            seq: p.event.seq,
            ts: p.event.ts ?? new Date().toISOString(),
            type: p.event.type,
            payload:
              typeof p.event.payload === "string"
                ? p.event.payload
                : JSON.stringify(p.event.payload ?? {}),
          };
          setEvents((prev) => (prev.some((e) => e.seq === row.seq) ? prev : [...prev, row]));
        }
        if (
          p.event?.type === "node.started" ||
          p.event?.type === "node.completed" ||
          p.event?.type === "task.completed" ||
          p.event?.type === "task.failed"
        ) {
          scheduleDetail();
        }
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [id, reload]);

  useEffect(() => {
    if (!task || ["done", "failed", "cancelled", "merged"].includes(task.status)) return;
    const tick = setInterval(() => {
      void api
        .listEvents(id)
        .then((ev) => setEvents(ev.events))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(tick);
  }, [id, task]);

  return { task, repo, kernel, detail, events, error, setError, reload };
}
