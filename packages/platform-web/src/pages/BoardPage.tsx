import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { boardActionContext, taskActionsEnabled } from "@devtools/shared";
import { api, type Task } from "../api";
import { errorText, useToast } from "../components/Toast";
import { FilterBar, type FilterOption } from "../components/FilterBar";
import { TaskListView, type ListGrouping, type ListSort } from "../components/TaskListView";
import { useTaskStore } from "../task-store";
import { useUi } from "../ui-store";
import { formatCombo, useKeyBindings } from "../shortcuts";
import { StatusIcon } from "../components/StatusIcon";
import {
  COLUMNS,
  EMPTY_FILTERS,
  TERMINAL_STATUSES,
  activeFilterCount,
  filtersFromParams,
  filtersToParams,
  laneOfStatus,
  rangeOf,
  taskMatchesFilters,
  type BoardFilters,
} from "../board-filters";

const MENU_ACTIONS = [
  { key: "pause" as const, label: "暂停", run: (id: string) => api.pause(id) },
  { key: "resume" as const, label: "继续", run: (id: string) => api.resume(id) },
  { key: "abort" as const, label: "中止", run: (id: string) => api.abort(id) },
  { key: "cancel" as const, label: "取消", run: (id: string) => api.cancel(id) },
  { key: "retry" as const, label: "重试", run: (id: string) => api.retry(id) },
];

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
  const { tasks, repos, loaded, error: loadError, applyTask, removeTask } = useTaskStore();
  const toast = useToast();
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  /** Scoped to the create dialog: form errors belong next to the form, not in a toast. */
  const [formError, setFormError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const ui = useUi();
  const createOpen = ui.createOpen;
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

  const closeCreate = () => {
    ui.closeCreate();
    setFormError(null);
  };

  const closeDelete = () => {
    setPendingDelete(null);
  };

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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menus = document.querySelectorAll<HTMLDetailsElement>("details.board-card-menu[open]");
      for (const menu of menus) {
        if (!(event.target instanceof Node) || !menu.contains(event.target)) {
          menu.open = false;
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  const repoName = useMemo(() => {
    const m = new Map(repos.map((r) => [r.id, r.full_name]));
    return (id: string) => m.get(id) ?? id;
  }, [repos]);

  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  const patchFilters = useCallback(
    (patch: Partial<BoardFilters>) => {
      setSearchParams(filtersToParams({ ...filters, ...patch }), { replace: true });
    },
    [filters, setSearchParams],
  );

  const resetFilters = useCallback(() => {
    setSearchParams(filtersToParams(EMPTY_FILTERS), { replace: true });
  }, [setSearchParams]);

  const timeRange = useMemo(() => rangeOf(filters), [filters]);

  const filteredTasks = useMemo(
    () => tasks.filter((t) => taskMatchesFilters(t, filters, { repoName, range: timeRange })),
    [tasks, filters, repoName, timeRange],
  );

  const openTaskCount = useMemo(
    () => filteredTasks.filter((task) => !TERMINAL_STATUSES.includes(task.status)).length,
    [filteredTasks],
  );

  // Lane counts ignore the lane filter itself, so the menu still shows what you'd get
  // by ticking another box.
  const laneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      if (!taskMatchesFilters(task, { ...filters, lanes: [] }, { repoName, range: timeRange })) {
        continue;
      }
      const lane = laneOfStatus(task.status);
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

  const visibleColumns = useMemo(
    () => (filters.lanes.length ? COLUMNS.filter((c) => filters.lanes.includes(c.key)) : COLUMNS),
    [filters.lanes],
  );

  const activeFilters = activeFilterCount(filters);

  // View preferences live in the URL too, so a shared link reproduces exactly what
  // the sender was looking at.
  const view = searchParams.get("view") === "list" ? "list" : "board";
  const grouping = (searchParams.get("group") as ListGrouping) || "lane";
  const sort = (searchParams.get("sort") as ListSort) || "updated";

  const setViewParam = useCallback(
    (key: string, value: string, fallback: string) => {
      const next = new URLSearchParams(searchParams);
      if (value === fallback) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const pipelineOptions =
    form.pipeline && !pipelines.includes(form.pipeline) ? [form.pipeline, ...pipelines] : pipelines;

  const canSubmit = !!form.repoId && !!form.requirement && !!form.pipeline && !pipelinesLoading;

  useKeyBindings([
    {
      combo: "f",
      run: () => searchRef.current?.focus(),
      enabled: !ui.anyOverlayOpen && !pendingDelete,
    },
    {
      combo: "v",
      run: () => setViewParam("view", view === "list" ? "board" : "list", "board"),
      enabled: !ui.anyOverlayOpen && !pendingDelete,
    },
  ]);

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

  const runCardAction = async (
    e: MouseEvent<HTMLButtonElement>,
    task: Task,
    label: string,
    run: (id: string) => Promise<unknown>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = e.currentTarget.closest("details") as HTMLDetailsElement | null;
    if (menu) menu.open = false;
    try {
      await run(task.id);
      toast.success(`已${label}「${task.title}」`);
    } catch (err) {
      toast.error(`${label}失败：${task.title}`, err);
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

  return (
    <>
      <div className="board-page">
        {loadError && <p className="error board-error">无法刷新任务列表：{loadError}</p>}

        <div className="board-heading">
          <div>
            <h1>工作台</h1>
            <p>
              <span>
                {activeFilters > 0
                  ? `${filteredTasks.length} / ${tasks.length} 个任务`
                  : `${filteredTasks.length} 个任务`}
              </span>
              <span aria-hidden="true"> · </span>
              <span>{openTaskCount} 个未结束</span>
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
          trailing={
            <>
              {view === "list" && (
                <>
                  <label className="view-select">
                    <span>分组</span>
                    <select
                      value={grouping}
                      onChange={(e) => setViewParam("group", e.target.value, "lane")}
                    >
                      <option value="lane">状态</option>
                      <option value="repo">仓库</option>
                      <option value="none">不分组</option>
                    </select>
                  </label>
                  <label className="view-select">
                    <span>排序</span>
                    <select
                      value={sort}
                      onChange={(e) => setViewParam("sort", e.target.value, "updated")}
                    >
                      <option value="updated">最近更新</option>
                      <option value="created">创建时间</option>
                      <option value="title">标题</option>
                    </select>
                  </label>
                </>
              )}
              <div className="view-toggle" role="group" aria-label="视图">
                <button
                  type="button"
                  className={view === "board" ? "active" : ""}
                  aria-pressed={view === "board"}
                  onClick={() => setViewParam("view", "board", "board")}
                >
                  看板
                </button>
                <button
                  type="button"
                  className={view === "list" ? "active" : ""}
                  aria-pressed={view === "list"}
                  onClick={() => setViewParam("view", "list", "board")}
                >
                  列表
                </button>
              </div>
            </>
          }
        />

        {view === "list" ? (
          <TaskListView
            tasks={filteredTasks}
            repoName={repoName}
            grouping={grouping}
            sort={sort}
            keyboardEnabled={!ui.anyOverlayOpen && !pendingDelete}
            emptyHint={
              !loaded ? "加载中…" : activeFilters > 0 ? "没有匹配当前筛选的任务" : "还没有任务"
            }
          />
        ) : (
        <div className="board-viewport">
          <div
            className="board"
            style={{ "--board-columns": visibleColumns.length } as React.CSSProperties}
          >
            {visibleColumns.map((col) => {
              const items = filteredTasks.filter((t) => col.match.includes(t.status));
              return (
                <section key={col.key} className={`board-column board-column--${col.key}`}>
                  <header className="board-column-header">
                    <div>
                      <span className="board-column-dot" aria-hidden="true" />
                      <h2>{col.title}</h2>
                    </div>
                    <span className="Counter" aria-label={`${items.length} 个任务`}>
                      {items.length}
                    </span>
                  </header>
                  <div className="board-column-body">
                    {items.length === 0 && (
                      <p className="board-column-empty">
                        {!loaded ? "加载中…" : activeFilters > 0 ? "无匹配任务" : "暂无任务"}
                      </p>
                    )}
                    {items.map((t) => {
                      const actions = taskActionsEnabled(boardActionContext(t));
                      const repository = repoName(t.repo_id);
                      return (
                        <div key={t.id} className="board-card">
                          <Link className="board-card-main" to={`/tasks/${t.id}`}>
                            <p className="title" title={t.title}>
                              <span className="board-card-status">
                                <StatusIcon status={t.status} size={13} />
                              </span>
                              {t.title}
                            </p>
                            <div className="board-card-context">
                              <span className="board-card-repo" title={repository}>
                                {repository}
                              </span>
                              {t.issue_number != null && <span>#{t.issue_number}</span>}
                            </div>
                            <div className="meta">
                              {t.current_node && (
                                <span className="Label Label--accent">{t.current_node}</span>
                              )}
                              {t.branch && (
                                <span className="Label board-card-branch" title={t.branch}>
                                  {t.branch}
                                </span>
                              )}
                            </div>
                            {t.error && (
                              <p className="board-card-error" title={t.error}>
                                {t.error}
                              </p>
                            )}
                          </Link>
                          <details className="board-card-menu">
                            <summary aria-label={`${t.title}的任务操作`}>⋯</summary>
                            <div className="board-card-menu-panel">
                              {MENU_ACTIONS.map((item) => (
                                <button
                                  key={item.key}
                                  type="button"
                                  disabled={!actions[item.key]}
                                  onClick={(e) => void runCardAction(e, t, item.label, item.run)}
                                >
                                  {item.label}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="board-card-menu-danger"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const menu = e.currentTarget.closest(
                                    "details",
                                  ) as HTMLDetailsElement | null;
                                  if (menu) menu.open = false;
                                  setPendingDelete({
                                    id: t.id,
                                    title: t.title,
                                    childCount: countDescendantTasks(tasks, t.id),
                                  });
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
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
                  还没有仓库，先到 <Link to="/settings/repos">配置 → 仓库</Link>{" "}
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
