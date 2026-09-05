import type { TaskStatus } from "../api";

/** Shared vocabulary for status colour, glyph and Chinese label across board and list. */
export const STATUS_META: Record<TaskStatus, { label: string; tone: string }> = {
  queued: { label: "排队", tone: "queued" },
  preparing: { label: "准备中", tone: "queued" },
  running: { label: "运行中", tone: "running" },
  delivering: { label: "交付中", tone: "running" },
  paused: { label: "暂停", tone: "paused" },
  waiting_human: { label: "等人", tone: "waiting" },
  done: { label: "完成", tone: "done" },
  merged: { label: "已合并", tone: "done" },
  failed: { label: "失败", tone: "failed" },
  cancelled: { label: "已取消", tone: "failed" },
};

export function statusLabel(status: TaskStatus): string {
  return STATUS_META[status]?.label ?? status;
}

export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const meta = STATUS_META[status];
  const tone = meta?.tone ?? "queued";
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    className: `status-icon status-icon--${tone}`,
    role: "img" as const,
    "aria-label": meta?.label ?? status,
  };

  if (tone === "done") {
    return (
      <svg {...common} fill="none">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M4.9 8.2l2.2 2.2 4.1-4.6"
          stroke="var(--canvas-default)"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (tone === "failed") {
    return (
      <svg {...common} fill="none">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
          stroke="var(--canvas-default)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (tone === "waiting") {
    return (
      <svg {...common} fill="none">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4.4v4" stroke="var(--canvas-default)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="8" cy="11.1" r="0.95" fill="var(--canvas-default)" />
      </svg>
    );
  }

  if (tone === "paused") {
    return (
      <svg {...common} fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.5 5.6v4.8M9.5 5.6v4.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (tone === "running") {
    // Arc + dashed remainder reads as "in progress" without needing a percentage.
    return (
      <svg {...common} fill="none">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
        <path
          className="status-icon-spin"
          d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg {...common} fill="none">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.6 2.4"
      />
    </svg>
  );
}
