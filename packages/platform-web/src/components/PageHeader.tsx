import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function PageHeader({
  crumb,
  title,
  description,
  badge,
  meta,
  actions,
  sticky,
}: {
  crumb?: { to: string; label: string };
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Pin the title while the rest of the page scrolls, GitHub-issue style. */
  sticky?: boolean;
}) {
  return (
    <header className={`page-header${sticky ? " page-header--sticky" : ""}`}>
      {crumb && (
        <nav className="page-crumb" aria-label="面包屑">
          <Link to={crumb.to}>← {crumb.label}</Link>
        </nav>
      )}
      <div className="page-heading">
        <div className="page-heading-main">
          <h1>
            <span className="page-title-text">{title}</span>
            {badge}
          </h1>
          {description && <div className="page-desc">{description}</div>}
          {meta && <div className="page-meta">{meta}</div>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}
