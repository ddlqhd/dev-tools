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
  connectTaskStream,
  type KernelTaskSnapshot,
  type Repo,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from "./api";
import { mergePersistedAndLive } from "./merge-events";

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
    setTask((prev) =>
      prev && prev.id === info.task.id && prev.updated_at > info.task.updated_at ? prev : info.task,
    );
    setRepo(info.repo);
    setKernel(info.kernel);
    const ev = await api.listEvents(id);
    setEvents((prev) => mergePersistedAndLive(ev.events, prev));
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
    setEvents([]);
    setError(null);
    void reload().catch((e: Error) => setError(e.message));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDetail = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reload().catch(() => undefined);
      }, 400);
    };

    const appendEvent = (row: TaskEvent) => {
      setEvents((prev) => (prev.some((e) => e.seq === row.seq) ? prev : [...prev, row]));
    };

    const offStream = connectTaskStream(id, (event) => {
      appendEvent({
        task_id: id,
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        payload:
          typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload ?? {}),
      });
      if (
        event.type === "node.started" ||
        event.type === "node.completed" ||
        event.type === "task.completed" ||
        event.type === "task.failed"
      ) {
        scheduleDetail();
      }
    });

    const off = connectHub((msg) => {
      if (msg.type === "task.updated") {
        const t = msg.payload as Task;
        if (t.id === id) {
          setTask((prev) =>
            prev && prev.updated_at > t.updated_at ? prev : t,
          );
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
      offStream();
      off();
    };
  }, [id, reload]);

  useEffect(() => {
    if (!task || ["done", "failed", "cancelled", "merged"].includes(task.status)) return;
    const tick = setInterval(() => {
      void api
        .listEvents(id)
        .then((ev) => setEvents((prev) => mergePersistedAndLive(ev.events, prev)))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(tick);
  }, [id, task]);

  return { task, repo, kernel, detail, events, error, setError, reload };
}
