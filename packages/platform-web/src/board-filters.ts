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

export const COLD_LANES = ["done", "failed"] as const;
export type ColdLane = (typeof COLD_LANES)[number];

export type BoardView = "board" | "list" | "focus";

/** Attention view: needs-you first, history last. */
export const ATTENTION_COLUMNS: typeof COLUMNS = [
  COLUMNS.find((c) => c.key === "waiting_human")!,
  COLUMNS.find((c) => c.key === "failed")!,
  COLUMNS.find((c) => c.key === "paused")!,
  COLUMNS.find((c) => c.key === "running")!,
  COLUMNS.find((c) => c.key === "queued")!,
  COLUMNS.find((c) => c.key === "done")!,
];
export type KeepMode = "7d" | "30d" | "all";

export const KEEP_PRESETS: Array<{ mode: KeepMode; label: string }> = [
  { mode: "7d", label: "近 7 天" },
  { mode: "30d", label: "近 30 天" },
  { mode: "all", label: "全部保留" },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VIEW_KEYS = ["view", "group", "sort", "archived"] as const;

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
  /** Terminal-task decay. Independent of the created_at time filter. */
  keep: KeepMode;
};

export const EMPTY_FILTERS: BoardFilters = {
  q: "",
  lanes: [],
  repos: [],
  pipelines: [],
  time: "all",
  from: "",
  to: "",
  keep: "7d",
};

export function defaultKeep(view: BoardView): KeepMode {
  return view === "list" ? "all" : "7d";
}

export function parseBoardView(value: string | null): BoardView | null {
  if (value === "list" || value === "board" || value === "focus") return value;
  return null;
}

export function isColdLane(key: string): key is ColdLane {
  return (COLD_LANES as readonly string[]).includes(key);
}

function isTimeMode(value: string): value is TimeFilterMode {
  return value === "all" || value === "today" || value === "7d" || value === "30d" || value === "custom";
}

function isKeepMode(value: string): value is KeepMode {
  return value === "7d" || value === "30d" || value === "all";
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function filtersFromParams(params: URLSearchParams, view: BoardView = "board"): BoardFilters {
  const time = params.get("t");
  const keep = params.get("keep");
  return {
    q: params.get("q") ?? "",
    lanes: splitList(params.get("lane")),
    repos: splitList(params.get("repo")),
    pipelines: splitList(params.get("pipeline")),
    time: time && isTimeMode(time) ? time : "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    keep: keep && isKeepMode(keep) ? keep : defaultKeep(view),
  };
}

/** Only non-default values are written, so a clean board keeps a clean URL. */
export function filtersToParams(filters: BoardFilters, view: BoardView = "board"): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.lanes.length) params.set("lane", filters.lanes.join(","));
  if (filters.repos.length) params.set("repo", filters.repos.join(","));
  if (filters.pipelines.length) params.set("pipeline", filters.pipelines.join(","));
  if (filters.time !== "all") params.set("t", filters.time);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.keep !== defaultKeep(view)) params.set("keep", filters.keep);
  return params;
}

/** Merge filter params onto the current URL without dropping view/group/sort. */
export function applyFiltersToSearchParams(
  current: URLSearchParams,
  filters: BoardFilters,
  view: BoardView,
): URLSearchParams {
  const next = filtersToParams(filters, view);
  for (const key of VIEW_KEYS) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  return next;
}

export function activeFilterCount(filters: BoardFilters, view: BoardView = "board"): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    (filters.lanes.length ? 1 : 0) +
    (filters.repos.length ? 1 : 0) +
    (filters.pipelines.length ? 1 : 0) +
    (filters.time !== "all" ? 1 : 0) +
    (filters.keep !== defaultKeep(view) ? 1 : 0)
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

/** Terminal tasks older than `keep` drop off the board. Hot tasks always pass. */
export function taskMatchesKeep(task: Task, keep: KeepMode, now: number = Date.now()): boolean {
  if (keep === "all") return true;
  if (!TERMINAL_STATUSES.includes(task.status)) return true;
  const ts = Date.parse(task.updated_at);
  if (Number.isNaN(ts)) return false;
  const days = keep === "7d" ? 7 : 30;
  return now - ts < days * MS_PER_DAY;
}

export function rangeOf(filters: BoardFilters): TimeRange | null {
  return resolveTimeRange(filters.time, filters.from, filters.to);
}
