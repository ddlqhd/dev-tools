import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Task, type TaskStatus } from "../api";
import { COLUMNS, TERMINAL_STATUSES, isColdLane, laneOfStatus } from "../board-filters";
import { StatusIcon, statusLabel } from "./StatusIcon";
import { fmtRelative } from "../format";
import { useToast } from "./Toast";

export type ListGrouping = "lane" | "repo" | "none";
export type ListSort = "updated" | "created" | "title";

const SORTERS: Record<ListSort, (a: Task, b: Task) => number> = {
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
  created: (a, b) => b.created_at.localeCompare(a.created_at),
  title: (a, b) => a.title.localeCompare(b.title),
};

type Group = { key: string; title: string; tasks: Task[]; collapsible: boolean };

type WalkItem =
  | { kind: "group"; key: string }
  | { kind: "task"; id: string };

function groupTasks(
  tasks: Task[],
  grouping: ListGrouping,
  repoName: (id: string) => string,
  lanes: Array<{ key: string; title: string; match: TaskStatus[] }>,
): Group[] {
  if (grouping === "none") {
    return [{ key: "all", title: "全部任务", tasks, collapsible: false }];
  }

  if (grouping === "repo") {
    const byRepo = new Map<string, Task[]>();
    for (const task of tasks) {
      const list = byRepo.get(task.repo_id);
      if (list) list.push(task);
      else byRepo.set(task.repo_id, [task]);
    }
    return [...byRepo.entries()]
      .map(([id, list]) => ({ key: id, title: repoName(id), tasks: list, collapsible: false }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  // Lane order is the pipeline order, so empty lanes are simply dropped.
  return lanes
    .map((col) => ({
      key: col.key,
      title: col.title,
      tasks: tasks.filter((t) => laneOfStatus(t.status) === col.key),
      collapsible: isColdLane(col.key),
    }))
    .filter((g) => g.tasks.length > 0);
}

export const LIST_DEFAULT_COLLAPSED = ["done", "failed"] as const;
export const FOCUS_DEFAULT_COLLAPSED = ["done"] as const;

export function TaskListView({
  tasks,
  repoName,
  grouping,
  sort,
  emptyHint,
  keyboardEnabled,
  lanes = COLUMNS,
  collapsedMore = false,
  defaultCollapsed = LIST_DEFAULT_COLLAPSED,
  onArchived,
}: {
  tasks: Task[];
  repoName: (id: string) => string;
  grouping: ListGrouping;
  sort: ListSort;
  emptyHint: string;
  keyboardEnabled: boolean;
  lanes?: Array<{ key: string; title: string; match: TaskStatus[] }>;
  /** When a cold group is collapsed, show "还有 N 个" instead of just the count. */
  collapsedMore?: boolean;
  defaultCollapsed?: readonly string[];
  onArchived?: (task: Task) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const collapsedKey = defaultCollapsed.join(",");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsed));
  const rootRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const sorted = [...tasks].sort(SORTERS[sort]);
    return groupTasks(sorted, grouping, repoName, lanes);
  }, [tasks, grouping, sort, repoName, lanes]);

  useEffect(() => {
    setCollapsed(new Set(collapsedKey.split(",").filter(Boolean)));
    setActiveGroup(null);
  }, [grouping, collapsedKey]);

  const walk = useMemo<WalkItem[]>(() => {
    const items: WalkItem[] = [];
    for (const group of groups) {
      if (group.collapsible && collapsed.has(group.key)) {
        items.push({ kind: "group", key: group.key });
        continue;
      }
      for (const task of group.tasks) items.push({ kind: "task", id: task.id });
    }
    return items;
  }, [groups, collapsed]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    if (activeId && !walk.some((item) => item.kind === "task" && item.id === activeId)) {
      setActiveId(null);
    }
    if (activeGroup && !walk.some((item) => item.kind === "group" && item.key === activeGroup)) {
      setActiveGroup(null);
    }
  }, [walk, activeId, activeGroup]);

  useEffect(() => {
    if (!keyboardEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      if (walk.length === 0) return;

      const currentIndex = walk.findIndex((item) =>
        item.kind === "task" ? item.id === activeId : item.key === activeGroup,
      );

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const step = e.key === "j" ? 1 : -1;
        const next = currentIndex < 0 ? (step > 0 ? 0 : walk.length - 1) : currentIndex + step;
        const clamped = (next + walk.length) % walk.length;
        const item = walk[clamped]!;
        if (item.kind === "task") {
          setActiveId(item.id);
          setActiveGroup(null);
        } else {
          setActiveId(null);
          setActiveGroup(item.key);
        }
        return;
      }
      if (e.key === "Enter") {
        if (activeGroup) {
          e.preventDefault();
          toggleGroup(activeGroup);
          const group = groups.find((g) => g.key === activeGroup);
          const first = group?.tasks[0];
          if (first) {
            setActiveGroup(null);
            setActiveId(first.id);
          }
          return;
        }
        if (activeId) {
          e.preventDefault();
          navigate(`/tasks/${activeId}`);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [walk, activeId, activeGroup, keyboardEnabled, navigate, groups]);

  useEffect(() => {
    const selector = activeId
      ? `[data-task-id="${CSS.escape(activeId)}"]`
      : activeGroup
        ? `[data-group-key="${CSS.escape(activeGroup)}"]`
        : null;
    if (!selector) return;
    rootRef.current?.querySelector(selector)?.scrollIntoView({ block: "nearest" });
  }, [activeId, activeGroup]);

  if (tasks.length === 0) {
    return <p className="task-list-empty">{emptyHint}</p>;
  }

  return (
    <div className="task-list" ref={rootRef}>
      {groups.map((group) => {
        const isCollapsed = group.collapsible && collapsed.has(group.key);
        return (
          <section key={group.key} className="task-list-group">
            <header
              className={`task-list-group-head${group.collapsible ? " is-collapsible" : ""}${
                activeGroup === group.key ? " is-active" : ""
              }`}
              data-group-key={group.key}
              {...(group.collapsible
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    "aria-expanded": !isCollapsed,
                    onClick: () => toggleGroup(group.key),
                    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleGroup(group.key);
                      }
                    },
                  }
                : {})}
            >
              <h2>{group.title}</h2>
              <span className="Counter">{group.tasks.length}</span>
              {group.collapsible && isCollapsed && collapsedMore && (
                <span className="task-list-more">还有 {group.tasks.length} 个</span>
              )}
              {group.collapsible && (
                <span className="task-list-group-caret" aria-hidden="true">
                  {isCollapsed ? "▸" : "▾"}
                </span>
              )}
            </header>
            {!isCollapsed &&
              group.tasks.map((task) => (
                <div
                  key={task.id}
                  data-task-id={task.id}
                  className={`task-row${task.id === activeId ? " is-active" : ""}`}
                  onMouseEnter={() => {
                    setActiveId(task.id);
                    setActiveGroup(null);
                  }}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/tasks/${task.id}`);
                    }
                  }}
                  role="link"
                  tabIndex={0}
                >
                  <span className="task-row-status" title={statusLabel(task.status)}>
                    <StatusIcon status={task.status} />
                  </span>
                  <span className="task-row-title" title={task.title}>
                    {task.title}
                  </span>
                  <span className="task-row-meta">
                    {task.archived_at && <span className="Label">已归档</span>}
                    {task.current_node && (
                      <span className="Label Label--accent">{task.current_node}</span>
                    )}
                    {task.issue_number != null && <span className="muted">#{task.issue_number}</span>}
                    {task.branch && (
                      <span className="task-row-branch" title={task.branch}>
                        {task.branch}
                      </span>
                    )}
                  </span>
                  <span className="task-row-repo" title={repoName(task.repo_id)}>
                    {repoName(task.repo_id)}
                  </span>
                  <time className="task-row-time" dateTime={task.updated_at}>
                    {fmtRelative(task.updated_at)}
                  </time>
                  {onArchived && TERMINAL_STATUSES.includes(task.status) && (
                    <button
                      type="button"
                      className="task-row-archive"
                      onClick={(e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void (async () => {
                          try {
                            const res = task.archived_at
                              ? await api.unarchive(task.id)
                              : await api.archive(task.id);
                            onArchived(res.task);
                            toast.success(
                              task.archived_at
                                ? `已取消归档「${task.title}」`
                                : `已归档「${task.title}」`,
                            );
                          } catch (err) {
                            toast.error(
                              `${task.archived_at ? "取消归档" : "归档"}失败：${task.title}`,
                              err,
                            );
                          }
                        })();
                      }}
                    >
                      {task.archived_at ? "取消归档" : "归档"}
                    </button>
                  )}
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}
