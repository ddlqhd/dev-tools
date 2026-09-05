import type { Task, TaskStatus } from "./api";
import {
  resolveTimeRange,
  taskMatchesTimeRange,
  type TimeFilterMode,
  type TimeRange,
} from "./task-time-filter.ts";

/** Board columns double as the status filter vocabulary: users think in lanes, not raw statuses. */
export const COLUMNS: Array<{ key: string; title: string; match: TaskStatus[] }> = [
  { key: "queued", title: "排队", match: ["queued", "preparing"] },
  { key: "running", title: "运行中", match: ["running", "delivering"] },
  { key: "paused", title: "暂停", match: ["paused"] },
  { key: "waiting_human", title: "等人", match: ["waiting_human"] },
  { key: "done", title: "完成", match: ["done", "merged"] },
  { key: "failed", title: "失败", match: ["failed", "cancelled"] },
];

export const TERMINAL_STATUSES: TaskStatus[] = ["done", "merged", "failed", "cancelled"];

export type BoardFilters = {
  /** Free-text match over title, repo name and branch. */
  q: string;
  /** Column keys, not raw statuses. Empty means "no status filter". */
  lanes: string[];
  repos: string[];
  pipelines: string[];
  time: TimeFilterMode;
  from: string;
  to: string;
};

export const EMPTY_FILTERS: BoardFilters = {
  q: "",
  lanes: [],
  repos: [],
  pipelines: [],
  time: "all",
  from: "",
  to: "",
};

function isTimeMode(value: string): value is TimeFilterMode {
  return value === "all" || value === "today" || value === "7d" || value === "30d" || value === "custom";
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function filtersFromParams(params: URLSearchParams): BoardFilters {
  const time = params.get("t");
  return {
    q: params.get("q") ?? "",
    lanes: splitList(params.get("lane")),
    repos: splitList(params.get("repo")),
    pipelines: splitList(params.get("pipeline")),
    time: time && isTimeMode(time) ? time : "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
}

/** Only non-default values are written, so a clean board keeps a clean URL. */
export function filtersToParams(filters: BoardFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.lanes.length) params.set("lane", filters.lanes.join(","));
  if (filters.repos.length) params.set("repo", filters.repos.join(","));
  if (filters.pipelines.length) params.set("pipeline", filters.pipelines.join(","));
  if (filters.time !== "all") params.set("t", filters.time);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params;
}

export function activeFilterCount(filters: BoardFilters): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    (filters.lanes.length ? 1 : 0) +
    (filters.repos.length ? 1 : 0) +
    (filters.pipelines.length ? 1 : 0) +
    (filters.time !== "all" ? 1 : 0)
  );
}

export function laneOfStatus(status: TaskStatus): string | undefined {
  return COLUMNS.find((c) => c.match.includes(status))?.key;
}

export type TaskMatchContext = {
  repoName: (repoId: string) => string;
  range: TimeRange | null;
};

export function taskMatchesFilters(
  task: Task,
  filters: BoardFilters,
  ctx: TaskMatchContext,
): boolean {
  if (!taskMatchesTimeRange(task.created_at, ctx.range)) return false;

  if (filters.lanes.length) {
    const lane = laneOfStatus(task.status);
    if (!lane || !filters.lanes.includes(lane)) return false;
  }

  if (filters.repos.length && !filters.repos.includes(task.repo_id)) return false;

  if (filters.pipelines.length) {
    if (!task.pipeline_name || !filters.pipelines.includes(task.pipeline_name)) return false;
  }

  const q = filters.q.trim().toLowerCase();
  if (q) {
    const haystack = [task.title, ctx.repoName(task.repo_id), task.branch ?? "", task.current_node ?? ""]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

export function rangeOf(filters: BoardFilters): TimeRange | null {
  return resolveTimeRange(filters.time, filters.from, filters.to);
}
