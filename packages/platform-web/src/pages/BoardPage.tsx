import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { boardActionContext, taskActionsEnabled } from "@devtools/shared";
import { api, connectHub, type Repo, type Task, type TaskStatus } from "../api";
import { stateClass } from "../format";
import {
  resolveTimeRange,
  taskMatchesTimeRange,
  type TimeFilterMode,
} from "../task-time-filter";

const COLUMNS: Array<{ key: TaskStatus | "active"; title: string; match: TaskStatus[] }> = [
  { key: "queued", title: "排队", match: ["queued", "preparing"] },
  { key: "running", title: "运行中", match: ["running", "delivering"] },
  { key: "paused", title: "暂停", match: ["paused"] },
  { key: "waiting_human", title: "等人", match: ["waiting_human"] },
  { key: "done", title: "完成", match: ["done", "merged"] },
  { key: "failed", title: "失败", match: ["failed", "cancelled"] },
];

const TERMINAL_STATUSES: TaskStatus[] = ["done", "merged", "failed", "cancelled"];

const TIME_PRESETS: Array<{ mode: TimeFilterMode; label: string }> = [
  { mode: "all", label: "全部" },
  { mode: "today", label: "今天" },
  { mode: "7d", label: "近7天" },
  { mode: "30d", label: "近1个月" },
];

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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeMode, setTimeMode] = useState<TimeFilterMode>("all");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
    setCreateOpen(false);
    setError(null);
  };

  const closeDelete = () => {
    setPendingDelete(null);
  };

  const reload = async () => {
    const [t, r] = await Promise.all([api.listTasks(), api.listRepos()]);
    setTasks(t.tasks);
    setRepos(r.repos);
    if (!form.repoId && r.repos[0]) {
      setForm((f) => ({ ...f, repoId: r.repos[0]!.id }));
    }
  };

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const off = connectHub((msg) => {
      if (msg.type === "task.updated" && msg.payload) {
        const task = msg.payload as Task;
        setTasks((prev) => {
          const idx = prev.findIndex((x) => x.id === task.id);
          if (idx < 0) return [task, ...prev];
          const next = [...prev];
          next[idx] = task;
          return next;
        });
        if (task.status === "waiting_human" && "Notification" in window) {
          if (Notification.permission === "granted") {
            new Notification("codeloop: 需要人工介入", { body: task.title });
          } else if (Notification.permission !== "denied") {
            void Notification.requestPermission();
          }
        }
      }
      if (msg.type === "task.deleted" && msg.payload) {
        const { id } = msg.payload as { id: string };
        setTasks((prev) => prev.filter((t) => t.id !== id));
      }
    });
    return off;
  }, []);

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
    setError(null);
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
        setError(e.message);
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
          setCreateOpen(false);
          setError(null);
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

  const timeRange = useMemo(
    () => resolveTimeRange(timeMode, rangeFrom, rangeTo),
    [timeMode, rangeFrom, rangeTo],
  );
  const filteredTasks = useMemo(
    () => tasks.filter((t) => taskMatchesTimeRange(t.created_at, timeRange)),
    [tasks, timeRange],
  );
  const openTaskCount = useMemo(
    () => filteredTasks.filter((task) => !TERMINAL_STATUSES.includes(task.status)).length,
    [filteredTasks],
  );

  const pipelineOptions =
    form.pipeline && !pipelines.includes(form.pipeline) ? [form.pipeline, ...pipelines] : pipelines;

  const selectPreset = (mode: TimeFilterMode) => {
    setTimeMode(mode);
    setRangeFrom("");
    setRangeTo("");
  };

  const create = async () => {
    setError(null);
    try {
      await api.createTask({
        repoId: form.repoId,
        title: form.title || form.requirement.slice(0, 72),
        requirement: form.requirement,
        pipeline: form.pipeline || undefined,
      });
      setForm((f) => ({ ...f, title: "", requirement: "" }));
      setCreateOpen(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runCardAction = async (
    e: MouseEvent<HTMLButtonElement>,
    taskId: string,
    run: (id: string) => Promise<unknown>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = e.currentTarget.closest("details") as HTMLDetailsElement | null;
    if (menu) menu.open = false;
    setError(null);
    try {
      await run(taskId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setError(null);
    try {
      await api.deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="board-page">
        {!createOpen && !pendingDelete && error && <p className="error board-error">{error}</p>}

        <div className="board-heading">
          <div>
            <h1>任务看板</h1>
            <p>
              <span>{filteredTasks.length} 个任务</span>
              <span aria-hidden="true"> · </span>
              <span>{openTaskCount} 个未结束</span>
            </p>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              setError(null);
              setCreateOpen(true);
            }}
          >
            新建任务
          </button>
        </div>

        <div className="board-filterbar" aria-label="按创建时间筛选">
          <span className="board-filter-label">创建时间</span>
          <div className="board-preset-group" role="group" aria-label="快捷时间范围">
            {TIME_PRESETS.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                className={timeMode === mode ? "btn active" : "btn"}
                aria-pressed={timeMode === mode}
                onClick={() => selectPreset(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="board-date-range">
            <label className="board-date-field">
              <span>从</span>
              <input
                type="date"
                value={rangeFrom}
                onChange={(e) => {
                  setRangeFrom(e.target.value);
                  setTimeMode("custom");
                }}
              />
            </label>
            <span className="board-date-separator" aria-hidden="true">
              —
            </span>
            <label className="board-date-field">
              <span>到</span>
              <input
                type="date"
                value={rangeTo}
                onChange={(e) => {
                  setRangeTo(e.target.value);
                  setTimeMode("custom");
                }}
              />
            </label>
          </div>
        </div>

        <div className="board-viewport">
          <div className="board">
            {COLUMNS.map((col) => {
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
                    {items.length === 0 && <p className="board-column-empty">暂无任务</p>}
                    {items.map((t) => {
                      const actions = taskActionsEnabled(boardActionContext(t));
                      const repository = repoName(t.repo_id);
                      return (
                        <div key={t.id} className="board-card">
                          <Link className="board-card-main" to={`/tasks/${t.id}`}>
                            <p className="title" title={t.title}>
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
                              {t.status === "paused" && (
                                <span className={`State ${stateClass("paused")}`}>暂停</span>
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
                                  onClick={(e) => void runCardAction(e, t.id, item.run)}
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
                                  setError(null);
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
      </div>

      {createOpen && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <div
            className="modal-panel Box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-task-title"
            onClick={(e) => e.stopPropagation()}
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
                disabled={!form.repoId || !form.requirement || !form.pipeline || pipelinesLoading}
              >
                入队
              </button>
              {pipelinesLoading && <p className="muted">加载 Pipeline…</p>}
              {error && <p className="error">{error}</p>}
              {!repos.length && (
                <p className="muted">还没有仓库，先去「仓库」页接入本地或 GitHub 仓库。</p>
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
              <button className="btn" type="button" onClick={closeDelete}>
                取消
              </button>
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
              {error && <p className="error">{error}</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
