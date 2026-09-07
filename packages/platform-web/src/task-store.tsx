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
import { useLocation } from "react-router-dom";
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
  includeArchived: boolean;
  reload: () => Promise<void>;
  reloadRepos: () => Promise<void>;
  /** Insert or replace one repo and invalidate in-flight list snapshots. */
  applyRepo: (repo: Repo) => void;
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

function includeArchivedFromLocation(pathname: string, search: string): boolean {
  return pathname === "/" && new URLSearchParams(search).get("archived") === "1";
}

export function TaskStoreProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const includeArchived = includeArchivedFromLocation(location.pathname, location.search);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const includeArchivedRef = useRef(includeArchived);
  includeArchivedRef.current = includeArchived;
  const { status: hubStatus, generation } = useHubSync();
  const notified = useRef(new Set<string>());
  /** Monotonic ids so a newer list/upsert wins, and a failed fetch does not discard an older success. */
  const reposFetch = useRef({ next: 0, applied: 0 });

  const beginReposWrite = () => ++reposFetch.current.next;

  const commitRepos = (id: number, write: () => void) => {
    if (id < reposFetch.current.applied) return;
    reposFetch.current.applied = id;
    write();
  };

  const reloadRepos = useCallback(async () => {
    const id = beginReposWrite();
    const r = await api.listRepos();
    commitRepos(id, () => setRepos(r.repos));
  }, []);

  const applyRepo = useCallback((repo: Repo) => {
    const id = beginReposWrite();
    commitRepos(id, () => setRepos((prev) => upsertRepo(prev, repo)));
  }, []);

  const reload = useCallback(async () => {
    const fetchedAt = new Date().toISOString();
    const repoId = beginReposWrite();
    try {
      const [t, r] = await Promise.all([
        api.listTasks({ archived: includeArchived }),
        api.listRepos(),
      ]);
      setTasks((prev) => {
        const merged = mergeTaskSnapshot(prev, t.tasks, fetchedAt);
        return includeArchived ? merged : merged.filter((task) => !task.archived_at);
      });
      commitRepos(repoId, () => setRepos(r.repos));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setLoaded(true);
    }
  }, [includeArchived]);

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
        if (task.archived_at && !includeArchivedRef.current) removeTask(task.id);
        else applyTask(task);
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
      includeArchived,
      reload,
      reloadRepos,
      applyRepo,
      applyTask,
      removeTask,
    }),
    [
      tasks,
      repos,
      loaded,
      error,
      hubStatus,
      waitingHumanCount,
      includeArchived,
      reload,
      reloadRepos,
      applyRepo,
      applyTask,
      removeTask,
    ],
  );

  return <TaskStoreContext.Provider value={value}>{children}</TaskStoreContext.Provider>;
}

function upsertRepo(prev: Repo[], repo: Repo): Repo[] {
  const idx = prev.findIndex((r) => r.id === repo.id);
  const next = idx < 0 ? [...prev, repo] : prev.map((item, i) => (i === idx ? repo : item));
  next.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return next;
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
