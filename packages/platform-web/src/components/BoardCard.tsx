import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { boardActionContext, taskActionsEnabled } from "@devtools/shared";
import { api, type Task } from "../api";
import { TERMINAL_STATUSES } from "../board-filters";
import { fmtRelative } from "../format";
import { useToast } from "./Toast";
import { StatusIcon } from "./StatusIcon";

const MENU_ACTIONS = [
  { key: "pause" as const, label: "暂停", run: (id: string) => api.pause(id) },
  { key: "resume" as const, label: "继续", run: (id: string) => api.resume(id) },
  { key: "abort" as const, label: "中止", run: (id: string) => api.abort(id) },
  { key: "cancel" as const, label: "取消", run: (id: string) => api.cancel(id) },
  { key: "retry" as const, label: "重试", run: (id: string) => api.retry(id) },
];

export function BoardCard({
  task,
  repository,
  compact,
  active,
  onHover,
  onRequestDelete,
  onArchived,
}: {
  task: Task;
  repository: string;
  compact: boolean;
  active: boolean;
  onHover: () => void;
  onRequestDelete: () => void;
  onArchived: (task: Task) => void;
}) {
  const toast = useToast();
  const actions = taskActionsEnabled(boardActionContext(task));

  const runAction = async (
    e: MouseEvent<HTMLButtonElement>,
    label: string,
    run: (id: string) => Promise<unknown>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await run(task.id);
      toast.success(`已${label}「${task.title}」`);
    } catch (err) {
      toast.error(`${label}失败：${task.title}`, err);
    }
  };

  return (
    <div
      data-task-id={task.id}
      className={`board-card${compact ? " board-card--compact" : ""}${active ? " is-active" : ""}`}
      onMouseEnter={onHover}
    >
      <Link className="board-card-main" to={`/tasks/${task.id}`}>
        <p className="title" title={task.error ? `${task.title}\n${task.error}` : task.title}>
          <span className="board-card-status">
            <StatusIcon status={task.status} size={13} />
          </span>
          {task.title}
          {compact && task.error && (
            <span className="board-card-error-dot" title={task.error} aria-label="有错误" />
          )}
        </p>
        {compact ? (
          <div className="board-card-context">
            <span className="board-card-repo" title={repository}>
              {repository}
            </span>
            {task.archived_at && <span className="Label">已归档</span>}
            <time dateTime={task.updated_at}>{fmtRelative(task.updated_at)}</time>
          </div>
        ) : (
          <>
            <div className="board-card-context">
              <span className="board-card-repo" title={repository}>
                {repository}
              </span>
              {task.archived_at && <span className="Label">已归档</span>}
              {task.issue_number != null && <span>#{task.issue_number}</span>}
            </div>
            <div className="meta">
              {task.current_node && <span className="Label Label--accent">{task.current_node}</span>}
              {task.branch && (
                <span className="Label board-card-branch" title={task.branch}>
                  {task.branch}
                </span>
              )}
            </div>
            {task.error && (
              <p className="board-card-error" title={task.error}>
                {task.error}
              </p>
            )}
          </>
        )}
      </Link>
      <BoardCardMenu
        title={task.title}
        actions={MENU_ACTIONS.map((item) => ({
          key: item.key,
          label: item.label,
          disabled: !actions[item.key],
          onClick: (e) => void runAction(e, item.label, item.run),
        }))}
        onDelete={onRequestDelete}
        archived={!!task.archived_at}
        canArchive={TERMINAL_STATUSES.includes(task.status)}
        onArchive={async () => {
          try {
            const res = task.archived_at
              ? await api.unarchive(task.id)
              : await api.archive(task.id);
            onArchived(res.task);
            toast.success(task.archived_at ? `已取消归档「${task.title}」` : `已归档「${task.title}」`);
          } catch (err) {
            toast.error(`${task.archived_at ? "取消归档" : "归档"}失败：${task.title}`, err);
          }
        }}
      />
    </div>
  );
}

function BoardCardMenu({
  title,
  actions,
  onDelete,
  archived,
  canArchive,
  onArchive,
}: {
  title: string;
  actions: Array<{
    key: string;
    label: string;
    disabled: boolean;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  }>;
  onDelete: () => void;
  archived: boolean;
  canArchive: boolean;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const place = () => {
      const rect = btnRef.current!.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
    };
    place();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div className="board-card-menu">
      <button
        ref={btnRef}
        type="button"
        className="board-card-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${title}的任务操作`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="board-card-menu-panel"
            role="menu"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
          >
            {actions.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(e) => {
                  setOpen(false);
                  item.onClick(e);
                }}
              >
                {item.label}
              </button>
            ))}
            {canArchive && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  onArchive();
                }}
              >
                {archived ? "取消归档" : "归档"}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="board-card-menu-danger"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                onDelete();
              }}
            >
              删除
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
