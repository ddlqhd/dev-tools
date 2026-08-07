export type TaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_human"
  | "delivering"
  | "done"
  | "failed"
  | "cancelled";

export interface Repo {
  id: string;
  platform: string;
  full_name: string;
  clone_path: string;
  trigger_label: string;
  max_concurrency: number;
  default_branch: string;
  has_github_token?: boolean;
}

export interface Task {
  id: string;
  repo_id: string;
  source: string;
  issue_number: number | null;
  title: string;
  requirement: string;
  status: TaskStatus;
  priority: number;
  instance_id: string | null;
  kernel_task_id: string | null;
  branch: string | null;
  pr_number: number | null;
  current_node: string | null;
  loop_state: string | null;
  pipeline_name: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Instance {
  id: string;
  launcher: string;
  repo_id: string | null;
  endpoint: string;
  pid: number | null;
  status: string;
  started_at: string;
  last_seen_at: string;
}

export interface TaskEvent {
  task_id: string;
  seq: number;
  ts: string;
  type: string;
  payload: string;
}

/** PLATFORM_TOKEN for console: localStorage, or Vite env at build time. */
export function getPlatformToken(): string | undefined {
  try {
    const fromStore = localStorage.getItem("platformToken");
    if (fromStore) return fromStore;
  } catch {
    // ignore
  }
  const fromEnv = import.meta.env.VITE_PLATFORM_TOKEN as string | undefined;
  return fromEnv || undefined;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as T;
}

export const api = {
  listRepos: () => req<{ repos: Repo[] }>("/api/repos"),
  createRepo: (body: {
    fullName: string;
    clonePath?: string;
    triggerLabel?: string;
    maxConcurrency?: number;
    defaultBranch?: string;
  }) =>
    req<{ repo: Repo }>("/api/repos", { method: "POST", body: JSON.stringify(body) }),
  listTasks: () => req<{ tasks: Task[] }>("/api/tasks"),
  createTask: (body: {
    repoId: string;
    title: string;
    requirement: string;
    pipeline?: string;
  }) => req<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  getTask: (id: string) =>
    req<{ task: Task; repo: Repo; kernel: unknown }>(`/api/tasks/${id}`),
  listEvents: (id: string, after = 0) =>
    req<{ events: TaskEvent[] }>(`/api/tasks/${id}/events?after=${after}`),
  artifact: async (id: string, artifactId: string) => {
    const token = getPlatformToken();
    const res = await fetch(`/api/tasks/${id}/artifacts/${artifactId}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.text();
  },
  pause: (id: string) => req(`/api/tasks/${id}/pause`, { method: "POST", body: "{}" }),
  resume: (id: string, instruction?: string) =>
    req(`/api/tasks/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    }),
  abort: (id: string) => req(`/api/tasks/${id}/abort`, { method: "POST", body: "{}" }),
  cancel: (id: string) => req(`/api/tasks/${id}/cancel`, { method: "POST", body: "{}" }),
  retry: (id: string) => req(`/api/tasks/${id}/retry`, { method: "POST", body: "{}" }),
  inject: (id: string, text: string) =>
    req(`/api/tasks/${id}/instructions`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  intervene: (
    id: string,
    reqId: string,
    decision: { action: string; comments?: unknown[]; note?: string },
  ) =>
    req(`/api/tasks/${id}/interventions/${reqId}`, {
      method: "POST",
      body: JSON.stringify(decision),
    }),
  listInstances: () => req<{ instances: Instance[] }>("/api/instances"),
  terminateInstance: (id: string) =>
    req(`/api/instances/${id}/terminate`, { method: "POST", body: "{}" }),
};

export function connectHub(onMessage: (msg: { type: string; payload: unknown }) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getPlatformToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/api/stream${q}`);
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as { type: string; payload: unknown });
    } catch {
      // ignore
    }
  };
  return () => ws.close();
}
