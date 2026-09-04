export type TimeFilterMode = "all" | "today" | "7d" | "30d" | "custom";

export type TimeRange = { start: number; endExclusive: number };

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function parseYmd(ymd: string): Date | null {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

export function resolveTimeRange(
  mode: TimeFilterMode,
  fromYmd: string,
  toYmd: string,
  now: Date = new Date(),
): TimeRange | null {
  if (mode === "all") return null;

  if (mode === "today" || mode === "7d" || mode === "30d") {
    const todayStart = startOfLocalDay(now);
    const daysBack = mode === "today" ? 0 : mode === "7d" ? 6 : 29;
    const start = addLocalDays(todayStart, -daysBack).getTime();
    const endExclusive = addLocalDays(todayStart, 1).getTime();
    return { start, endExclusive };
  }

  // custom
  const fromRaw = fromYmd.trim();
  const toRaw = toYmd.trim();
  if (!fromRaw && !toRaw) return null;

  let from = fromRaw ? parseYmd(fromRaw) : null;
  let to = toRaw ? parseYmd(toRaw) : null;
  if (fromRaw && !from) return null;
  if (toRaw && !to) return null;

  if (from && to && from.getTime() > to.getTime()) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  const start = from ? from.getTime() : Number.NEGATIVE_INFINITY;
  const endExclusive = to ? addLocalDays(to, 1).getTime() : Number.POSITIVE_INFINITY;
  return { start, endExclusive };
}

export function taskMatchesTimeRange(createdAtIso: string, range: TimeRange | null): boolean {
  if (range == null) return true;
  const ts = Date.parse(createdAtIso);
  if (Number.isNaN(ts)) return false;
  return ts >= range.start && ts < range.endExclusive;
}
