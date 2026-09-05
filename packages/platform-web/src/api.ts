import type { TaskDetail as SharedTaskDetail, WorkflowView } from "@devtools/shared";
import { getPlatformToken } from "./api-token";

export type {
  ArtifactFile,
  InterventionRecord,
  StageExecution,
  UsageTotals,
  WorkflowLoopView,
  WorkflowNodeStatus,
  WorkflowNodeView,
  WorkflowStepView,
  WorkflowView,
} from "@devtools/shared";

export type TaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "waiting_human"
  | "delivering"
  | "done"
  | "merged"
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

export interface EngineConfig {
  type: string;
  model?: string;
}

/** Mirrors kernel CodeloopConfig over the platform API. */
export interface CodeloopConfig {
  version: 1;
  pipeline: string;
  pipelineOverrides?: Record<string, unknown>;
  engines: Record<string, EngineConfig>;
  budget: {
    maxEngineCalls: number;
    nodeTimeoutMinutes: number;
  };
  git: {
    branchPrefix: string;
    worktreeRoot: string;
  };
  autoApproveGates: boolean;
  skipVerifyIfMissing: boolean;
  inplace: boolean;
  sandbox: boolean;
}

export interface ConfigMeta {
  pipelines: string[];
  engines: Array<{ id: string; label: string }>;
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
  parent_task_id?: string | null;
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

export type KernelTaskSnapshot = {
  task?: { status?: string };
  pendingIntervention?: { requestId?: string; kind?: string; summary?: string } | null;
};

/** Wire payload: older kernels omit `workflow`. */
export type TaskDetail = Omit<SharedTaskDetail, "workflow"> & { workflow?: WorkflowView };

export { getPlatformToken };
export { connectHub, subscribeHubStatus, useHubStatus, useHubSync } from "./hub";
export type { HubMessage, HubStatus } from "./hub";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body != null ? { "content-type": "application/json" } : {}),
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
  updateRepo: (
    id: string,
    body: {
      clonePath?: string;
      triggerLabel?: string;
      maxConcurrency?: number;
      defaultBranch?: string;
      githubToken?: string;
    },
  ) =>
    req<{ repo: Repo }>(`/api/repos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  getConfigMeta: () => req<ConfigMeta>("/api/config/meta"),
  getRepoConfig: (id: string) =>
    req<{ config: CodeloopConfig; pipelines: string[] }>(`/api/repos/${id}/config`),
  putRepoConfig: (id: string, config: CodeloopConfig) =>
    req<{ config: CodeloopConfig }>(`/api/repos/${id}/config`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  listTasks: () => req<{ tasks: Task[] }>("/api/tasks"),
  createTask: (body: {
    repoId: string;
    title: string;
    requirement: string;
    pipeline?: string;
  }) => req<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  getTask: (id: string) =>
    req<{ task: Task; repo: Repo; kernel: KernelTaskSnapshot | null }>(`/api/tasks/${id}`),
  listEvents: (id: string, after = 0) =>
    req<{ events: TaskEvent[] }>(`/api/tasks/${id}/events?after=${after}`),
  getDetail: (id: string) => req<{ detail: TaskDetail }>(`/api/tasks/${id}/detail`),
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
  deleteTask: (id: string) => req(`/api/tasks/${id}`, { method: "DELETE" }),
  retry: (id: string) => req(`/api/tasks/${id}/retry`, { method: "POST", body: "{}" }),
  inject: (id: string, text: string) =>
    req(`/api/tasks/${id}/instructions`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  intervene: (
    id: string,
    reqId: string,
    decision: { action: string; comments?: unknown[]; content?: string },
  ) =>
    req(`/api/tasks/${id}/interventions/${reqId}`, {
      method: "POST",
      body: JSON.stringify(decision),
    }),
  listInstances: () => req<{ instances: Instance[] }>("/api/instances"),
  terminateInstance: (id: string) =>
    req(`/api/instances/${id}/terminate`, { method: "POST", body: "{}" }),
};
