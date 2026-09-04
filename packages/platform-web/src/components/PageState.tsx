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
