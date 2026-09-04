import type { ReactElement } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { BoardPage } from "./pages/BoardPage";
import { TaskPage } from "./pages/TaskPage";
import { NodeEventsPage } from "./pages/NodeEventsPage";
import { ReposPage } from "./pages/ReposPage";
import { InstancesPage } from "./pages/InstancesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useTheme, type ThemeChoice } from "./theme";

function MarkIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="butt">
        <path d="M14.518 4.249A8.15 8.15 0 0 1 20.145 11.716" />
        <path d="M17.453 18.057A8.15 8.15 0 0 1 8.174 19.196" />
        <path d="M4.028 13.694A8.15 8.15 0 0 1 7.681 5.088" />
      </g>
      <g fill="currentColor">
        <path d="M23.481 11.249L20.306 16.313L16.785 11.483Z" />
        <path d="M6.91 22.318L4.112 17.036L10.056 16.402Z" />
        <path d="M5.609 2.433L11.582 2.651L9.16 8.115Z" />
      </g>
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 0ZM3.464 3.404a.75.75 0 0 1 1.06 0l1.061 1.06a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215l-1.06-1.06a.75.75 0 0 1 0-1.06ZM0 8a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 8Zm13.25-.75a.75.75 0 0 0 0 1.5h1.5a.75.75 0 0 0 0-1.5h-1.5ZM8 13.25a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V14a.75.75 0 0 1 .75-.75Z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M1.75 2.5h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25ZM0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 13H1.75A1.75 1.75 0 0 1 0 11.25Zm5.5 10.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Z" />
    </svg>
  );
}

const THEME_OPTIONS: Array<{ key: ThemeChoice; title: string; icon: () => ReactElement }> = [
  { key: "light", title: "亮色", icon: SunIcon },
  { key: "dark", title: "暗色", icon: MoonIcon },
  { key: "system", title: "跟随系统", icon: SystemIcon },
];

export function App() {
  const [theme, setTheme] = useTheme();
  const location = useLocation();

  return (
    <>
      <header className="Header">
        <NavLink to="/" className="Header-logo">
          <MarkIcon />
          codeloop platform
        </NavLink>
        <nav>
          <NavLink to="/" end className={({ isActive }) => `Header-link${isActive ? " active" : ""}`}>
            看板
          </NavLink>
          <NavLink to="/repos" className={({ isActive }) => `Header-link${isActive ? " active" : ""}`}>
            仓库
          </NavLink>
          <NavLink to="/instances" className={({ isActive }) => `Header-link${isActive ? " active" : ""}`}>
            实例
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `Header-link${isActive ? " active" : ""}`}>
            配置
          </NavLink>
        </nav>
        <div className="theme-toggle" role="group" aria-label="主题">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              title={opt.title}
              className={theme === opt.key ? "active" : ""}
              onClick={() => setTheme(opt.key)}
            >
              <opt.icon />
            </button>
          ))}
        </div>
      </header>
      <main className={`container${location.pathname === "/" ? " container--board" : ""}`}>
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/tasks/:id/nodes/:nodeId" element={<NodeEventsPage />} />
          <Route path="/repos" element={<ReposPage />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </>
  );
}
