import type { ReactNode } from "react";

export function PageState({
  kind,
  title,
  children,
}: {
  kind: "loading" | "error" | "empty";
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`page-state page-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {title && <p className="page-state-title">{title}</p>}
      {children != null && children !== "" && <div className="page-state-body">{children}</div>}
    </div>
  );
}

/**
 * Structural placeholder for first paint. Reserving the real layout avoids the
 * jump that a centred "加载中…" causes when content lands.
 */
export function Skeleton({ lines = 3, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="skeleton" role="status" aria-label="加载中">
      {title && <div className="skeleton-bar skeleton-bar--title" />}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-bar" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function StatusBanner({
  kind,
  children,
}: {
  kind: "error" | "success";
  children: ReactNode;
}) {
  return (
    <p className={`status-banner status-banner--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
