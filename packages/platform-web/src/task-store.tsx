import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, connectHub, useHubSync, type HubStatus, type Repo, type Task } from "./api";
import { mergeTaskSnapshot, upsertTask } from "./merge-tasks";

/** Only used while the websocket is down; the hub is the primary transport. */
const DEGRADED_POLL_MS = 5_000;

type TaskStore = {
  tasks: Task[];
  repos: Repo[];
  loaded: boolean;
  /** Snapshot fetch failures only. Action errors are surfaced as toasts by callers. */
  error: string | null;
  hubStatus: HubStatus;
  waitingHumanCount: number;
  reload: () => Promise<void>;
  /** Local echo so the board updates before the hub round-trip lands. */
  applyTask: (task: Task) => void;
  removeTask: (id: string) => void;
};

const TaskStoreContext = createContext<TaskStore | null>(null);

export function useTaskStore(): TaskStore {
  const store = useContext(TaskStoreContext);
  if (!store) throw new Error("useTaskStore must be used inside <TaskStoreProvider>");
  return store;
}

export function TaskStoreProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status: hubStatus, generation } = useHubSync();
  const notified = useRef(new Set<string>());

  const reload = useCallback(async () => {
    const fetchedAt = new Date().toISOString();
    try {
      const [t, r] = await Promise.all([api.listTasks(), api.listRepos()]);
      setTasks((prev) => mergeTaskSnapshot(prev, t.tasks, fetchedAt));
      setRepos(r.repos);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setLoaded(true);
    }
  }, []);

  const applyTask = useCallback((task: Task) => {
    setTasks((prev) => upsertTask(prev, task));
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const off = connectHub((msg) => {
      if (msg.type === "task.updated" && msg.payload) {
        const task = msg.payload as Task;
        applyTask(task);
        if (task.status === "waiting_human") notifyWaitingHuman(task, notified.current);
        else notified.current.delete(task.id);
      }
      if (msg.type === "task.deleted" && msg.payload) {
        const { id } = msg.payload as { id: string };
        removeTask(id);
        notified.current.delete(id);
      }
    });
    return off;
  }, [applyTask, removeTask]);

  // Full reconciliation on first mount and after every reconnect: while the socket
  // was down we may have missed `task.updated` frames entirely.
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload, generation]);

  // Degraded mode: a proxy can block websockets while plain HTTP still works.
  useEffect(() => {
    if (hubStatus === "online") return;
    const tick = setInterval(() => void reload().catch(() => undefined), DEGRADED_POLL_MS);
    return () => clearInterval(tick);
  }, [hubStatus, reload]);

  const waitingHumanCount = useMemo(
    () => tasks.filter((t) => t.status === "waiting_human").length,
    [tasks],
  );

  const value = useMemo<TaskStore>(
    () => ({
      tasks,
      repos,
      loaded,
      error,
      hubStatus,
      waitingHumanCount,
      reload,
      applyTask,
      removeTask,
    }),
    [tasks, repos, loaded, error, hubStatus, waitingHumanCount, reload, applyTask, removeTask],
  );

  return <TaskStoreContext.Provider value={value}>{children}</TaskStoreContext.Provider>;
}

function notifyWaitingHuman(task: Task, seen: Set<string>) {
  if (seen.has(task.id)) return;
  seen.add(task.id);
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification("codeloop: 需要人工介入", { body: task.title });
  } else if (Notification.permission !== "denied") {
    void Notification.requestPermission();
  }
}
