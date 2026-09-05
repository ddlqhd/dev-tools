import { useEffect, useRef, type ReactNode } from "react";
import {
  COLUMNS,
  activeFilterCount,
  type BoardFilters,
} from "../board-filters";
import type { TimeFilterMode } from "../task-time-filter";

export type FilterOption = { value: string; label: string; count?: number };

const TIME_PRESETS: Array<{ mode: TimeFilterMode; label: string }> = [
  { mode: "all", label: "全部时间" },
  { mode: "today", label: "今天" },
  { mode: "7d", label: "近 7 天" },
  { mode: "30d", label: "近 1 个月" },
];

/** Closes any open chip popover when the user clicks elsewhere. */
function useCloseOnOutside(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menus = root.current?.querySelectorAll<HTMLDetailsElement>("details.chip[open]");
      if (!menus) return;
      for (const menu of menus) {
        if (!(event.target instanceof Node) || !menu.contains(event.target)) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [root]);
}

function summarize(selected: string[], options: FilterOption[]): string | null {
  if (selected.length === 0) return null;
  if (selected.length === 1) {
    return options.find((o) => o.value === selected[0])?.label ?? selected[0]!;
  }
  return `${selected.length} 项`;
}

function Chip({
  label,
  selected,
  options,
  onChange,
  emptyHint,
}: {
  label: string;
  selected: string[];
  options: FilterOption[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  const summary = summarize(selected, options);
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <details className={`chip${summary ? " chip--active" : ""}`}>
      <summary>
        <span className="chip-label">{label}</span>
        {summary && <span className="chip-value">{summary}</span>}
        <ChevronIcon />
      </summary>
      <div className="chip-menu">
        {options.length === 0 && <p className="chip-empty">{emptyHint ?? "暂无可选项"}</p>}
        {options.map((opt) => (
          <label key={opt.value} className="chip-option">
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => toggle(opt.value)}
            />
            <span className="chip-option-label">{opt.label}</span>
            {opt.count != null && <span className="chip-option-count">{opt.count}</span>}
          </label>
        ))}
        {selected.length > 0 && (
          <button type="button" className="chip-clear" onClick={() => onChange([])}>
            清除
          </button>
        )}
      </div>
    </details>
  );
}

function ChevronIcon() {
  return (
    <svg className="chip-caret" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4.427 7.427 7.823 10.823a.25.25 0 0 0 .354 0L11.573 7.427A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"
      />
    </svg>
  );
}

export function FilterBar({
  filters,
  onChange,
  onReset,
  repoOptions,
  pipelineOptions,
  laneCounts,
  searchRef,
  trailing,
}: {
  filters: BoardFilters;
  onChange: (patch: Partial<BoardFilters>) => void;
  onReset: () => void;
  repoOptions: FilterOption[];
  pipelineOptions: FilterOption[];
  laneCounts: Record<string, number>;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  trailing?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useCloseOnOutside(root);

  const active = activeFilterCount(filters);
  const timeLabel =
    filters.time === "custom"
      ? `${filters.from || "…"} → ${filters.to || "…"}`
      : (TIME_PRESETS.find((p) => p.mode === filters.time)?.label ?? "全部时间");

  return (
    <div className="filterbar" ref={root}>
      <div className="filter-search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
          placeholder="按标题、仓库、分支过滤"
          aria-label="过滤任务"
          spellCheck={false}
        />
        {filters.q && (
          <button
            type="button"
            className="filter-search-clear"
            aria-label="清除搜索"
            onClick={() => onChange({ q: "" })}
          >
            ×
          </button>
        )}
      </div>

      <Chip
        label="状态"
        selected={filters.lanes}
        options={COLUMNS.map((c) => ({ value: c.key, label: c.title, count: laneCounts[c.key] ?? 0 }))}
        onChange={(lanes) => onChange({ lanes })}
      />
      <Chip
        label="仓库"
        selected={filters.repos}
        options={repoOptions}
        onChange={(repos) => onChange({ repos })}
        emptyHint="还没有接入仓库"
      />
      <Chip
        label="Pipeline"
        selected={filters.pipelines}
        options={pipelineOptions}
        onChange={(pipelines) => onChange({ pipelines })}
        emptyHint="任务尚未记录 pipeline"
      />

      <details className={`chip${filters.time !== "all" ? " chip--active" : ""}`}>
        <summary>
          <span className="chip-label">时间</span>
          {filters.time !== "all" && <span className="chip-value">{timeLabel}</span>}
          <ChevronIcon />
        </summary>
        <div className="chip-menu">
          {TIME_PRESETS.map((preset) => (
            <button
              key={preset.mode}
              type="button"
              className={`chip-option chip-option--button${
                filters.time === preset.mode ? " is-selected" : ""
              }`}
              onClick={() => onChange({ time: preset.mode, from: "", to: "" })}
            >
              {preset.label}
            </button>
          ))}
          <div className="chip-range">
            <label>
              <span>从</span>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => onChange({ from: e.target.value, time: "custom" })}
              />
            </label>
            <label>
              <span>到</span>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => onChange({ to: e.target.value, time: "custom" })}
              />
            </label>
          </div>
        </div>
      </details>

      {active > 0 && (
        <button type="button" className="filter-reset" onClick={onReset}>
          清除筛选
          <span className="Counter">{active}</span>
        </button>
      )}

      {trailing && <div className="filterbar-trailing">{trailing}</div>}
    </div>
  );
}
