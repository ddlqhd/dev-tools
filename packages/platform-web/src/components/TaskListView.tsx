import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "../api";
import { COLUMNS, laneOfStatus } from "../board-filters";
import { StatusIcon, statusLabel } from "./StatusIcon";
import { fmtRelative } from "../format";

export type ListGrouping = "lane" | "repo" | "none";
export type ListSort = "updated" | "created" | "title";

const SORTERS: Record<ListSort, (a: Task, b: Task) => number> = {
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
  created: (a, b) => b.created_at.localeCompare(a.created_at),
  title: (a, b) => a.title.localeCompare(b.title),
};

type Group = { key: string; title: string; tasks: Task[] };

function groupTasks(
  tasks: Task[],
  grouping: ListGrouping,
  repoName: (id: string) => string,
): Group[] {
  if (grouping === "none") {
    return [{ key: "all", title: "全部任务", tasks }];
  }

  if (grouping === "repo") {
    const byRepo = new Map<string, Task[]>();
    for (const task of tasks) {
      const list = byRepo.get(task.repo_id);
      if (list) list.push(task);
      else byRepo.set(task.repo_id, [task]);
    }
    return [...byRepo.entries()]
      .map(([id, list]) => ({ key: id, title: repoName(id), tasks: list }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  // Lane order is the pipeline order, so empty lanes are simply dropped.
  return COLUMNS.map((col) => ({
    key: col.key,
    title: col.title,
    tasks: tasks.filter((t) => laneOfStatus(t.status) === col.key),
  })).filter((g) => g.tasks.length > 0);
}

export function TaskListView({
  tasks,
  repoName,
  grouping,
  sort,
  emptyHint,
  keyboardEnabled,
}: {
  tasks: Task[];
  repoName: (id: string) => string;
  grouping: ListGrouping;
  sort: ListSort;
  emptyHint: string;
  keyboardEnabled: boolean;
}) {
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const sorted = [...tasks].sort(SORTERS[sort]);
    return groupTasks(sorted, grouping, repoName);
  }, [tasks, grouping, sort, repoName]);

  /** Flattened order is what J/K walks; it must match render order exactly. */
  const flatIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups]);

  useEffect(() => {
    if (activeId && !flatIds.includes(activeId)) setActiveId(null);
  }, [flatIds, activeId]);

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
      if (flatIds.length === 0) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const at = activeId ? flatIds.indexOf(activeId) : -1;
        const step = e.key === "j" ? 1 : -1;
        const next = at < 0 ? (step > 0 ? 0 : flatIds.length - 1) : at + step;
        const clamped = (next + flatIds.length) % flatIds.length;
        setActiveId(flatIds[clamped]!);
        return;
      }
      if (e.key === "Enter" && activeId) {
        e.preventDefault();
        navigate(`/tasks/${activeId}`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flatIds, activeId, keyboardEnabled, navigate]);

  useEffect(() => {
    if (!activeId) return;
    rootRef.current
      ?.querySelector(`[data-task-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  if (tasks.length === 0) {
    return <p className="task-list-empty">{emptyHint}</p>;
  }

  return (
    <div className="task-list" ref={rootRef}>
      {groups.map((group) => (
        <section key={group.key} className="task-list-group">
          <header className="task-list-group-head">
            <h2>{group.title}</h2>
            <span className="Counter">{group.tasks.length}</span>
          </header>
          {group.tasks.map((task) => (
            <div
              key={task.id}
              data-task-id={task.id}
              className={`task-row${task.id === activeId ? " is-active" : ""}`}
              onMouseEnter={() => setActiveId(task.id)}
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
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
