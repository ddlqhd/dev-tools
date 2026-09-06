import { COLD_LANES, type ColdLane } from "./board-filters.ts";

export const LANE_PREFS_KEY = "codeloop.board.lanes";
export const COLLAPSE_THRESHOLD = 8;

export type LaneFold = "collapsed" | "expanded";
export type LanePrefs = Partial<Record<ColdLane, LaneFold>>;

export function parseLanePrefs(raw: string | null): LanePrefs {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const out: LanePrefs = {};
    for (const key of COLD_LANES) {
      const value = record[key];
      if (value === "collapsed" || value === "expanded") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readLanePrefs(): LanePrefs {
  if (typeof localStorage === "undefined") return {};
  try {
    return parseLanePrefs(localStorage.getItem(LANE_PREFS_KEY));
  } catch {
    return {};
  }
}

export function writeLanePrefs(prefs: LanePrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LANE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or private mode — folding still works for the session.
  }
}

export const DENSITY_KEY = "codeloop.board.density";
export const PAGE_SIZES = [10, 25, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type CompactMode = "auto" | "on" | "off";

export type DensityPrefs = {
  compact: CompactMode;
  pageSize: PageSize;
};

export const DEFAULT_DENSITY: DensityPrefs = { compact: "auto", pageSize: 10 };
export const AUTO_COMPACT_THRESHOLD = 100;

export function parseDensityPrefs(raw: string | null): DensityPrefs {
  if (!raw) return { ...DEFAULT_DENSITY };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_DENSITY };
    const record = parsed as Record<string, unknown>;
    const compact =
      record.compact === "on" || record.compact === "off" || record.compact === "auto"
        ? record.compact
        : "auto";
    const pageSize = PAGE_SIZES.includes(record.pageSize as PageSize)
      ? (record.pageSize as PageSize)
      : 10;
    return { compact, pageSize };
  } catch {
    return { ...DEFAULT_DENSITY };
  }
}

export function readDensityPrefs(): DensityPrefs {
  if (typeof localStorage === "undefined") return { ...DEFAULT_DENSITY };
  try {
    return parseDensityPrefs(localStorage.getItem(DENSITY_KEY));
  } catch {
    return { ...DEFAULT_DENSITY };
  }
}

export function writeDensityPrefs(prefs: DensityPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DENSITY_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function resolveCompact(prefs: DensityPrefs, taskCount: number): boolean {
  if (prefs.compact === "on") return true;
  if (prefs.compact === "off") return false;
  return taskCount > AUTO_COMPACT_THRESHOLD;
}

export function columnVisibleCount(total: number, revealed: number, pageSize: number): number {
  return Math.min(total, Math.max(pageSize, revealed));
}

/**
 * Cold lanes collapse past the threshold unless the user pinned them open,
 * or the status filter is showing only that lane.
 */
export function coldLaneCollapsed(
  lane: string,
  count: number,
  prefs: LanePrefs,
  lanesFilter: string[],
): boolean {
  if (!(COLD_LANES as readonly string[]).includes(lane)) return false;
  if (count === 0) return false;
  if (lanesFilter.length === 1 && lanesFilter[0] === lane) return false;
  const manual = prefs[lane as ColdLane];
  if (manual === "expanded") return false;
  if (manual === "collapsed") return true;
  return count >= COLLAPSE_THRESHOLD;
}
