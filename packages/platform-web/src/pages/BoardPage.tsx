import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type Task } from "../api";
import { errorText, useToast } from "../components/Toast";
import { ChoiceChip, FilterBar, type FilterOption } from "../components/FilterBar";
import { BoardCard } from "../components/BoardCard";
import {
  FOCUS_DEFAULT_COLLAPSED,
  LIST_DEFAULT_COLLAPSED,
  TaskListView,
  type ListGrouping,
  type ListSort,
} from "../components/TaskListView";
import { useTaskStore } from "../task-store";
import { useUi } from "../ui-store";
import { formatCombo, isTypingTarget, useKeyBindings } from "../shortcuts";
import {
  ATTENTION_COLUMNS,
  COLUMNS,
  EMPTY_FILTERS,
  TERMINAL_STATUSES,
  activeFilterCount,
  applyFiltersToSearchParams,
  defaultKeep,
  filtersFromParams,
  isColdLane,
  parseBoardView,
  rangeOf,
  taskMatchesFilters,
  taskMatchesKeep,
  type BoardFilters,
  type BoardView,
} from "../board-filters";
import {
  PAGE_SIZES,
  coldLaneCollapsed,
  columnVisibleCount,
  readDensityPrefs,
  readLanePrefs,
  resolveCompact,
  writeDensityPrefs,
  writeLanePrefs,
  type DensityPrefs,
  type LanePrefs,
} from "../board-lanes";

const NARROW_QUERY = "(max-width: 760px)";
const LIST_HINT_KEY = "codeloop.board.listHintDismissed";

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** Count all descendants of `rootId` in the board task list (ci-fix chains, etc.). */
function countDescendantTasks(tasks: Task[], rootId: string): number {
  const byParent = new Map<string, string[]>();
  for (const t of tasks) {
    const parent = t.parent_task_id;
    if (!parent) continue;
    const list = byParent.get(parent);
    if (list) list.push(t.id);
    else byParent.set(parent, [t.id]);
  }
  let count = 0;
  const stack = [...(byParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    count += 1;
    const kids = byParent.get(id);
    if (kids) stack.push(...kids);
  }
  return count;
}

export function BoardPage() {
  const {
    tasks,
    repos,
    loaded,
    error: loadError,
    applyTask,
    removeTask,
    includeArchived,
  } = useTaskStore();
  const toast = useToast();
  const navigate = useNavigate();
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  /** Scoped to the create dialog: form errors belong next to the form, not in a toast. */
  const [formError, setFormError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const createOpen = ui.createOpen;
  const narrow = useNarrowScreen();
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
    childCount: number;
  } | null>(null);
  const [form, setForm] = useState({
    repoId: "",
    title: "",
    requirement: "",
    pipeline: "",
  });
  const [lanePrefs, setLanePrefs] = useState<LanePrefs>(readLanePrefs);
  const [density, setDensity] = useState<DensityPrefs>(readDensityPrefs);
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<{ lane: string; taskId: string | null } | null>(null);
  const [hintDismissed, setHintDismissed] = useState(
    () => typeof sessionStorage !== "undefined" && sessionStorage.getItem(LIST_HINT_KEY) === "1",
  );

  const closeCreate = () => {
    ui.closeCreate();
    setFormError(null);
  };

  const closeDelete = () => {
    setPendingDelete(null);
  };

  const viewParam = searchParams.get("view");
  const view: BoardView = parseBoardView(viewParam) ?? (narrow ? "list" : "board");

  const grouping = (searchParams.get("group") as ListGrouping) || "lane";
  const sort = (searchParams.get("sort") as ListSort) || "updated";

  const filters = useMemo(() => filtersFromParams(searchParams, view), [searchParams, view]);

  const patchFilters = useCallback(
    (patch: Partial<BoardFilters>) => {
      setSearchParams(applyFiltersToSearchParams(searchParams, { ...filters, ...patch }, view), {
        replace: true,
      });
    },
    [filters, searchParams, setSearchParams, view],
  );

  const resetFilters = useCallback(() => {
    const next = applyFiltersToSearchParams(
      searchParams,
      { ...EMPTY_FILTERS, keep: defaultKeep(view) },
      view,
    );
    next.delete("archived");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, view]);

  const toggleArchived = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    if (searchParams.get("archived") === "1") next.delete("archived");
    else next.set("archived", "1");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const setView = useCallback(
    (next: BoardView) => {
      const params = new URLSearchParams(searchParams);
      params.set("view", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setViewParam = useCallback(
    (key: string, value: string, fallback: string) => {
      const next = new URLSearchParams(searchParams);
      if (value === fallback) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const persistLanePrefs = useCallback((next: LanePrefs) => {
    setLanePrefs(next);
    writeLanePrefs(next);
  }, []);

  const prevKeep = useRef(filters.keep);
  useEffect(() => {
    if (prevKeep.current !== "all" && filters.keep === "all") {
      setLanePrefs((prev) => {
        const next = { ...prev, done: "expanded" as const, failed: "expanded" as const };
        writeLanePrefs(next);
        return next;
      });
    }
    prevKeep.current = filters.keep;
  }, [filters.keep]);

  useEffect(() => {
    if (form.repoId || !repos[0]) return;
    setForm((f) => ({ ...f, repoId: repos[0]!.id }));
  }, [repos, form.repoId]);

  useEffect(() => {
    if (!createOpen) {
      setPipelinesLoading(false);
      return;
    }
    if (!form.repoId) {
      setPipelines([]);
      setForm((f) => ({ ...f, pipeline: "" }));
      setPipelinesLoading(false);
      return;
    }
    let cancelled = false;
    setPipelines([]);
    setForm((f) => ({ ...f, pipeline: "" }));
    setPipelinesLoading(true);
    setFormError(null);
    void api
      .getRepoConfig(form.repoId)
      .then((res) => {
        if (cancelled) return;
        setPipelines(res.pipelines);
        setForm((f) => ({ ...f, pipeline: res.config.pipeline }));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setPipelines([]);
        setForm((f) => ({ ...f, pipeline: "" }));
        setFormError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPipelinesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, form.repoId]);

  useEffect(() => {
    if (!createOpen && !pendingDelete) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingDelete) {
          setPendingDelete(null);
        } else {
          ui.closeCreate();
          setFormError(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createOpen, pendingDelete]);

  const repoName = useMemo(() => {
    const m = new Map(repos.map((r) => [r.id, r.full_name]));
    return (id: string) => m.get(id) ?? id;
  }, [repos]);

  const timeRange = useMemo(() => rangeOf(filters), [filters]);

  const matchedTasks = useMemo(
    () => tasks.filter((t) => taskMatchesFilters(t, filters, { repoName, range: timeRange })),
    [tasks, filters, repoName, timeRange],
  );

  const filteredTasks = useMemo(
    () => matchedTasks.filter((t) => taskMatchesKeep(t, filters.keep)),
    [matchedTasks, filters.keep],
  );

  const hiddenKeepCount = matchedTasks.length - filteredTasks.length;

  const openTaskCount = useMemo(
    () => filteredTasks.filter((task) => !TERMINAL_STATUSES.includes(task.status)).length,
    [filteredTasks],
  );

  // Lane counts ignore the lane filter itself, so the menu still shows what you'd get
  // by ticking another box. Keep is applied so the numbers match the board.
  const laneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      if (!taskMatchesFilters(task, { ...filters, lanes: [] }, { repoName, range: timeRange })) {
        continue;
      }
      if (!taskMatchesKeep(task, filters.keep)) continue;
      const lane = COLUMNS.find((c) => c.match.includes(task.status))?.key;
      if (lane) counts[lane] = (counts[lane] ?? 0) + 1;
    }
    return counts;
  }, [tasks, filters, repoName, timeRange]);

  const repoFilterOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.repo_id, (counts.get(t.repo_id) ?? 0) + 1);
    return repos
      .filter((r) => counts.has(r.id) || filters.repos.includes(r.id))
      .map((r) => ({ value: r.id, label: r.full_name, count: counts.get(r.id) ?? 0 }));
  }, [repos, tasks, filters.repos]);

  const pipelineFilterOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (!t.pipeline_name) continue;
      counts.set(t.pipeline_name, (counts.get(t.pipeline_name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ value: name, label: name, count }));
  }, [tasks]);

  const compactCards = resolveCompact(density, filteredTasks.length);

  const columns = useMemo(() => {
    const source = filters.lanes.length
      ? COLUMNS.filter((c) => filters.lanes.includes(c.key))
      : COLUMNS;
    return source
      .map((col) => {
        const items = filteredTasks.filter((t) => col.match.includes(t.status));
        const visible = columnVisibleCount(items.length, revealed[col.key] ?? 0, density.pageSize);
        return { ...col, items, visibleItems: items.slice(0, visible) };
      })
      .filter((col) => col.items.length > 0 || !isColdLane(col.key));
  }, [filters.lanes, filteredTasks, revealed, density.pageSize]);

  const hotColumns = useMemo(() => columns.filter((col) => !isColdLane(col.key)), [columns]);
  const coldColumns = useMemo(() => columns.filter((col) => isColdLane(col.key)), [columns]);

  const collapsedLanes = useMemo(() => {
    const set = new Set<string>();
    for (const col of columns) {
      if (coldLaneCollapsed(col.key, col.items.length, lanePrefs, filters.lanes)) {
        set.add(col.key);
      }
    }
    return set;
  }, [columns, lanePrefs, filters.lanes]);

  const toggleLane = useCallback(
    (key: string) => {
      if (!isColdLane(key)) return;
      const nextFold = collapsedLanes.has(key) ? "expanded" : "collapsed";
      persistLanePrefs({ ...lanePrefs, [key]: nextFold });
    },
    [collapsedLanes, lanePrefs, persistLanePrefs],
  );

  const activeFilters = activeFilterCount(filters, view) + (includeArchived ? 1 : 0);
  const showListHint =
    view === "board" && matchedTasks.length >= 40 && openTaskCount < 8 && !hintDismissed;

  const pipelineOptions =
    form.pipeline && !pipelines.includes(form.pipeline) ? [form.pipeline, ...pipelines] : pipelines;

  const canSubmit = !!form.repoId && !!form.requirement && !!form.pipeline && !pipelinesLoading;

  const countLabel =
    hiddenKeepCount > 0
      ? `${filteredTasks.length} / ${matchedTasks.length} 个任务`
      : activeFilters > 0
        ? `${filteredTasks.length} / ${tasks.length} 个任务`
        : `${filteredTasks.length} 个任务`;

  useKeyBindings([
    {
      combo: "f",
      run: () => searchRef.current?.focus(),
      enabled: !ui.anyOverlayOpen && !pendingDelete,
    },
    {
      combo: "v",
      run: () => {
        const order: BoardView[] = ["board", "list", "focus"];
        const at = order.indexOf(view);
        setView(order[(at + 1) % order.length]!);
      },
      enabled: !ui.anyOverlayOpen && !pendingDelete,
    },
  ]);

  useEffect(() => {
    if (view !== "board" || ui.anyOverlayOpen || pendingDelete) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const keys = ["j", "k", "[", "]", "c", "Enter"];
      if (!keys.includes(e.key)) return;

      const laneKeys = columns.map((c) => c.key);
      if (laneKeys.length === 0) return;

      const currentLane = focus && laneKeys.includes(focus.lane) ? focus.lane : laneKeys[0]!;
      const col = columns.find((c) => c.key === currentLane);
      const items = collapsedLanes.has(currentLane) ? [] : (col?.visibleItems ?? []);
      const at = focus?.taskId ? items.findIndex((t) => t.id === focus.taskId) : -1;

      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const idx = laneKeys.indexOf(currentLane);
        const step = e.key === "]" ? 1 : -1;
        const next = laneKeys[(idx + step + laneKeys.length) % laneKeys.length]!;
        setFocus({ lane: next, taskId: null });
        return;
      }

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        if (collapsedLanes.has(currentLane) && isColdLane(currentLane) && e.key === "j") {
          toggleLane(currentLane);
          const first = col?.items[0];
          setFocus({ lane: currentLane, taskId: first?.id ?? null });
          return;
        }
        if (items.length === 0) {
          setFocus({ lane: currentLane, taskId: null });
          return;
        }
        const step = e.key === "j" ? 1 : -1;
        if (e.key === "k" && at <= 0) {
          setFocus({ lane: currentLane, taskId: null });
          return;
        }
        if (
          e.key === "j" &&
          at === items.length - 1 &&
          col &&
          col.items.length > items.length
        ) {
          const nextTask = col.items[items.length];
          setRevealed((prev) => ({
            ...prev,
            [currentLane]: items.length + density.pageSize,
          }));
          if (nextTask) setFocus({ lane: currentLane, taskId: nextTask.id });
          return;
        }
        const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : at + step;
        const clamped = Math.max(0, Math.min(items.length - 1, next));
        setFocus({ lane: currentLane, taskId: items[clamped]!.id });
        return;
      }

      if (e.key === "c" && isColdLane(currentLane) && !focus?.taskId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleLane(currentLane);
        return;
      }

      if (e.key === "Enter") {
        if (focus?.taskId) {
          e.preventDefault();
          navigate(`/tasks/${focus.taskId}`);
          return;
        }
        if (focus && collapsedLanes.has(focus.lane) && isColdLane(focus.lane)) {
          e.preventDefault();
          toggleLane(focus.lane);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [view, ui.anyOverlayOpen, pendingDelete, columns, collapsedLanes, focus, navigate, toggleLane]);

  useEffect(() => {
    if (!focus?.taskId || !boardRef.current) return;
    boardRef.current
      .querySelector(`[data-task-id="${CSS.escape(focus.taskId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focus]);

  const create = async () => {
    setFormError(null);
    try {
      const created = await api.createTask({
        repoId: form.repoId,
        title: form.title || form.requirement.slice(0, 72),
        requirement: form.requirement,
        pipeline: form.pipeline || undefined,
      });
      applyTask(created.task);
      setForm((f) => ({ ...f, title: "", requirement: "" }));
      ui.closeCreate();
      toast.success(`已入队「${created.task.title}」`);
    } catch (e) {
      setFormError(errorText(e));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, title } = pendingDelete;
    try {
      await api.deleteTask(id);
      removeTask(id);
      setPendingDelete(null);
      toast.success(`已删除「${title}」`);
    } catch (err) {
      toast.error(`删除失败：${title}`, err);
    }
  };

  const dismissHint = () => {
    setHintDismissed(true);
    try {
      sessionStorage.setItem(LIST_HINT_KEY, "1");
    } catch {
      // ignore
    }
  };

  const renderColumn = (col: (typeof columns)[number]) => {
    const collapsed = collapsedLanes.has(col.key);
    const focused = focus?.lane === col.key && !focus.taskId;
    const cold = isColdLane(col.key);
    return (
      <section
        key={col.key}
        className={`board-column board-column--${col.key}${cold ? " board-column--cold" : ""}${
          collapsed ? " board-column--collapsed" : ""
        }${focused ? " is-focused" : ""}`}
        data-lane={col.key}
      >
        <header
          className="board-column-header"
          {...(cold
            ? {
                role: "button" as const,
                tabIndex: 0,
                "aria-expanded": !collapsed,
                "aria-label": collapsed
                  ? `展开${col.title}列，${col.items.length} 个任务`
                  : `折叠${col.title}列`,
                title: collapsed ? `展开${col.title}（${col.items.length}）` : undefined,
                onClick: () => toggleLane(col.key),
                onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleLane(col.key);
                  }
                },
              }
            : {})}
        >
          <div>
            <span className="board-column-dot" aria-hidden="true" />
            <h2>{col.title}</h2>
          </div>
          <span className="Counter" aria-label={`${col.items.length} 个任务`}>
            {col.items.length}
          </span>
        </header>
        {!collapsed && (
          <div className="board-column-body">
            {col.items.length === 0 && (
              <p className="board-column-empty">
                {!loaded ? "加载中…" : activeFilters > 0 ? "无匹配任务" : "暂无任务"}
              </p>
            )}
            {col.visibleItems.map((t) => (
              <BoardCard
                key={t.id}
                task={t}
                repository={repoName(t.repo_id)}
                compact={compactCards || cold}
                active={focus?.taskId === t.id}
                onHover={() => setFocus({ lane: col.key, taskId: t.id })}
                onRequestDelete={() =>
                  setPendingDelete({
                    id: t.id,
                    title: t.title,
                    childCount: countDescendantTasks(tasks, t.id),
                  })
                }
                onArchived={(next) => {
                  if (next.archived_at && !includeArchived) removeTask(next.id);
                  else applyTask(next);
                }}
              />
            ))}
            {col.items.length > col.visibleItems.length && (
              <button
                type="button"
                className="board-column-more"
                onClick={() =>
                  setRevealed((prev) => ({
                    ...prev,
                    [col.key]: col.visibleItems.length + density.pageSize,
                  }))
                }
              >
                再显示 {Math.min(density.pageSize, col.items.length - col.visibleItems.length)} 个
                <span>
                  {col.visibleItems.length} / {col.items.length}
                </span>
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <>
      <div className={`board-page${view === "board" ? " board-page--board" : " board-page--list"}`}>
        {loadError && <p className="error board-error">无法刷新任务列表：{loadError}</p>}

        <div className="board-heading">
          <div>
            <h1>工作台</h1>
            <p>
              <span>{countLabel}</span>
              <span aria-hidden="true"> · </span>
              <span>{openTaskCount} 个未结束</span>
              {hiddenKeepCount > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="board-keep-reveal"
                    onClick={() => patchFilters({ keep: "all" })}
                  >
                    {hiddenKeepCount} 个完成已收起
                  </button>
                </>
              )}
            </p>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              setFormError(null);
              ui.openCreate();
            }}
          >
            新建任务
          </button>
        </div>

        <FilterBar
          filters={filters}
          onChange={patchFilters}
          onReset={resetFilters}
          repoOptions={repoFilterOptions}
          pipelineOptions={pipelineFilterOptions}
          laneCounts={laneCounts}
          searchRef={searchRef}
          view={view}
          includeArchived={includeArchived}
          onToggleArchived={toggleArchived}
          trailing={
            <>
              {view === "list" && (
                <>
                  <ChoiceChip
                    label="分组"
                    value={grouping}
                    active={grouping !== "lane"}
                    options={[
                      { value: "lane", label: "状态" },
                      { value: "repo", label: "仓库" },
                      { value: "none", label: "不分组" },
                    ]}
                    onChange={(next) => setViewParam("group", next, "lane")}
                  />
                  <ChoiceChip
                    label="排序"
                    value={sort}
                    active={sort !== "updated"}
                    options={[
                      { value: "updated", label: "最近更新" },
                      { value: "created", label: "创建时间" },
                      { value: "title", label: "标题" },
                    ]}
                    onChange={(next) => setViewParam("sort", next, "updated")}
                  />
                </>
              )}
              {view === "board" && (
                <>
                  <ChoiceChip
                    label="密度"
                    value={density.compact}
                    active={density.compact !== "auto"}
                    options={[
                      { value: "auto", label: "自动" },
                      { value: "on", label: "紧凑" },
                      { value: "off", label: "舒适" },
                    ]}
                    onChange={(next) => {
                      const compact = next as DensityPrefs["compact"];
                      const prefs = { ...density, compact };
                      setDensity(prefs);
                      writeDensityPrefs(prefs);
                    }}
                  />
                  <ChoiceChip
                    label="每列"
                    value={String(density.pageSize)}
                    active={density.pageSize !== 10}
                    options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
                    onChange={(next) => {
                      const pageSize = Number(next) as DensityPrefs["pageSize"];
                      const prefs = { ...density, pageSize };
                      setDensity(prefs);
                      writeDensityPrefs(prefs);
                      setRevealed({});
                    }}
                  />
                </>
              )}
              <div className="view-toggle" role="group" aria-label="视图">
                <button
                  type="button"
                  className={view === "board" ? "active" : ""}
                  aria-pressed={view === "board"}
                  onClick={() => setView("board")}
                >
                  看板
                </button>
                <button
                  type="button"
                  className={view === "list" ? "active" : ""}
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  列表
                </button>
                <button
                  type="button"
                  className={view === "focus" ? "active" : ""}
                  aria-pressed={view === "focus"}
                  onClick={() => setView("focus")}
                >
                  注意
                </button>
              </div>
            </>
          }
        />

        {showListHint && (
          <p className="board-list-hint">
            任务较多，列表更适合扫
            <button type="button" onClick={() => setView("list")}>
              切换
            </button>
            <button type="button" className="board-list-hint-dismiss" onClick={dismissHint}>
              关闭
            </button>
          </p>
        )}

        {view === "list" || view === "focus" ? (
          <TaskListView
            tasks={filteredTasks}
            repoName={repoName}
            grouping={view === "focus" ? "lane" : grouping}
            sort={sort}
            lanes={view === "focus" ? ATTENTION_COLUMNS : COLUMNS}
            collapsedMore={view === "focus"}
            defaultCollapsed={view === "focus" ? FOCUS_DEFAULT_COLLAPSED : LIST_DEFAULT_COLLAPSED}
            keyboardEnabled={!ui.anyOverlayOpen && !pendingDelete}
            onArchived={(next) => {
              if (next.archived_at && !includeArchived) removeTask(next.id);
              else applyTask(next);
            }}
            emptyHint={
              !loaded ? "加载中…" : activeFilters > 0 ? "没有匹配当前筛选的任务" : "还没有任务"
            }
          />
        ) : (
          <div className="board-viewport">
            <div className="board" ref={boardRef}>
              {hotColumns.map(renderColumn)}
              {coldColumns.length > 0 && (
                <div className="board-cold">
                  {coldColumns.map(renderColumn)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {createOpen && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <div
            className="modal-panel Box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-task-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                e.preventDefault();
                void create();
              }
            }}
          >
            <div className="Box-header">
              <h2 id="create-task-title">新建任务</h2>
              <button className="btn" type="button" onClick={closeCreate}>
                取消
              </button>
            </div>
            <div className="Box-body">
              <div className="row" style={{ marginBottom: 12 }}>
                <label>
                  仓库
                  <select
                    value={form.repoId}
                    onChange={(e) => setForm({ ...form, repoId: e.target.value })}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.full_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Pipeline
                  <select
                    value={form.pipeline}
                    onChange={(e) => setForm({ ...form, pipeline: e.target.value })}
                    disabled={pipelinesLoading || !form.repoId || pipelineOptions.length === 0}
                  >
                    {pipelineOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  标题
                  <input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </label>
              </div>
              <label style={{ marginBottom: 12 }}>
                需求
                <textarea
                  value={form.requirement}
                  onChange={(e) => setForm({ ...form, requirement: e.target.value })}
                  placeholder="描述要实现的改动…"
                />
              </label>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void create()}
                disabled={!canSubmit}
              >
                入队
                <kbd className="kbd">{formatCombo("mod+enter")}</kbd>
              </button>
              {pipelinesLoading && <p className="muted">加载 Pipeline…</p>}
              {formError && <p className="error">{formError}</p>}
              {!repos.length && (
                <p className="muted">
                  还没有仓库，先到 <Link to="/settings/repos">配置 → 平台配置 → 仓库</Link>{" "}
                  接入本地或 GitHub 仓库。
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" onClick={closeDelete}>
          <div
            className="modal-panel Box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="Box-header">
              <h2 id="delete-task-title">删除任务</h2>
            </div>
            <div className="Box-body">
              <p>
                {pendingDelete.childCount > 0
                  ? `将永久删除「${pendingDelete.title}」及其 worktree 与本地任务数据，并一并删除 ${pendingDelete.childCount} 个子任务及其 worktree，此操作不可恢复。`
                  : `将永久删除「${pendingDelete.title}」及其 worktree 与本地任务数据，此操作不可恢复。`}
              </p>
              <div className="row" style={{ marginTop: 16, gap: 8 }}>
                <button className="btn" type="button" onClick={closeDelete}>
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => void confirmDelete()}
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
