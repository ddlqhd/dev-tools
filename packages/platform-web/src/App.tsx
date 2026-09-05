import { useMemo, useState, type ReactElement } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BoardPage } from "./pages/BoardPage";
import { TaskPage } from "./pages/TaskPage";
import { NodeEventsPage } from "./pages/NodeEventsPage";
import { InstancesPage } from "./pages/InstancesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CommandPalette, type CommandItem } from "./components/CommandPalette";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useTaskStore } from "./task-store";
import { useUi } from "./ui-store";
import { formatCombo, useKeyBindings } from "./shortcuts";
import { useTheme, type ThemeChoice } from "./theme";
import type { HubStatus } from "./api";

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

function BoardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="3.5" height="12" rx="1" stroke="currentColor" />
      <rect x="6.25" y="2" width="3.5" height="8" rx="1" stroke="currentColor" />
      <rect x="11" y="2" width="3.5" height="10" rx="1" stroke="currentColor" />
    </svg>
  );
}

function InstancesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="1.75" width="13" height="5" rx="1.25" stroke="currentColor" />
      <rect x="1.5" y="9.25" width="13" height="5" rx="1.25" stroke="currentColor" />
      <circle cx="4" cy="4.25" r="0.75" fill="currentColor" />
      <circle cx="4" cy="11.75" r="0.75" fill="currentColor" />
      <path d="M7 4.25h4.5M7 11.75h4.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2 3.5h12M2 8h12M2 12.5h12" />
      <circle cx="5" cy="3.5" r="1.5" fill="var(--sidebar-bg)" />
      <circle cx="10.5" cy="8" r="1.5" fill="var(--sidebar-bg)" />
      <circle cx="7" cy="12.5" r="1.5" fill="var(--sidebar-bg)" />
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

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d={collapsed ? "M6.25 2.75v10.5" : "M9.75 2.75v10.5"}
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

const THEME_OPTIONS: Array<{ key: ThemeChoice; title: string; icon: () => ReactElement }> = [
  { key: "light", title: "亮色", icon: SunIcon },
  { key: "dark", title: "暗色", icon: MoonIcon },
  { key: "system", title: "跟随系统", icon: SystemIcon },
];

const NAV_ITEMS: Array<{
  to: string;
  label: string;
  combo: string;
  icon: () => ReactElement;
}> = [
  { to: "/", label: "工作台", combo: "g b", icon: BoardIcon },
  { to: "/instances", label: "实例", combo: "g i", icon: InstancesIcon },
  { to: "/settings", label: "配置", combo: "g s", icon: SettingsIcon },
];

const HUB_LABEL: Record<HubStatus, string> = {
  online: "实时连接正常",
  connecting: "正在连接…",
  offline: "连接已断开，正在降级轮询",
};

const SIDEBAR_KEY = "codeloop-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function HubIndicator({ status, collapsed }: { status: HubStatus; collapsed: boolean }) {
  return (
    <span
      className={`hub-indicator hub-indicator--${status}`}
      title={HUB_LABEL[status]}
      aria-label={HUB_LABEL[status]}
    >
      <span className="hub-dot" aria-hidden="true" />
      {!collapsed && <span className="hub-text">{HUB_LABEL[status]}</span>}
    </span>
  );
}

export function App() {
  const [theme, setTheme] = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const { tasks, repos, hubStatus, waitingHumanCount } = useTaskStore();
  const ui = useUi();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const taskRouteActive = location.pathname.startsWith("/tasks/");

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const repoName = useMemo(() => {
    const map = new Map(repos.map((r) => [r.id, r.full_name]));
    return (id: string) => map.get(id) ?? id;
  }, [repos]);

  const commandItems = useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [
      {
        id: "action:create",
        group: "操作",
        label: "新建任务",
        combo: "c",
        run: ui.openCreate,
      },
      {
        id: "action:help",
        group: "操作",
        label: "查看快捷键",
        combo: "shift+/",
        run: () => ui.setHelpOpen(true),
      },
    ];

    const nav: CommandItem[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.to}`,
      group: "跳转",
      label: `前往${item.label}`,
      combo: item.combo,
      run: () => navigate(item.to),
    }));

    const themes: CommandItem[] = THEME_OPTIONS.map((opt) => ({
      id: `theme:${opt.key}`,
      group: "外观",
      label: `主题：${opt.title}`,
      run: () => setTheme(opt.key),
    }));

    // Newest first so an empty query surfaces what the user just created.
    const taskItems: CommandItem[] = [...tasks]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((task) => ({
        id: `task:${task.id}`,
        group: "任务",
        label: task.title,
        hint: [repoName(task.repo_id), task.status, task.branch ?? undefined]
          .filter(Boolean)
          .join(" · "),
        run: () => navigate(`/tasks/${task.id}`),
      }));

    return [...actions, ...nav, ...taskItems, ...themes];
  }, [tasks, repoName, navigate, setTheme, ui]);

  useKeyBindings([
    { combo: "mod+k", run: () => ui.setCommandOpen(true), whenTyping: true },
    { combo: "/", run: () => ui.setCommandOpen(true), enabled: !ui.anyOverlayOpen },
    { combo: "c", run: ui.openCreate, enabled: !ui.anyOverlayOpen },
    { combo: "?", run: () => ui.setHelpOpen(true), enabled: !ui.anyOverlayOpen },
    { combo: "g b", run: () => navigate("/"), enabled: !ui.anyOverlayOpen },
    { combo: "g i", run: () => navigate("/instances"), enabled: !ui.anyOverlayOpen },
    { combo: "g s", run: () => navigate("/settings"), enabled: !ui.anyOverlayOpen },
  ]);

  return (
    <div className={`app-shell${collapsed ? " app-shell--collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <aside className="sidebar" aria-label="主要导航">
        <div className="sidebar-head">
          <NavLink to="/" className="sidebar-logo" aria-label="CodeLoop 首页" draggable={false}>
            <span className="sidebar-mark">
              <MarkIcon />
            </span>
            {!collapsed && <span className="sidebar-brand">CodeLoop</span>}
          </NavLink>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={toggleCollapsed}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>

        <button
          type="button"
          className="sidebar-search"
          onClick={() => ui.setCommandOpen(true)}
          title="搜索任务或执行命令"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {!collapsed && (
            <>
              <span className="sidebar-search-label">搜索或跳转…</span>
              <kbd className="kbd">{formatCombo("mod+k")}</kbd>
            </>
          )}
        </button>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.to === "/"
                ? location.pathname === "/" || taskRouteActive
                : location.pathname.startsWith(item.to);
            const badge = item.to === "/" ? waitingHumanCount : 0;
            return (
              <Link
                key={item.to}
                to={item.to}
                draggable={false}
                aria-current={isActive ? "page" : undefined}
                className={`sidebar-link${isActive ? " active" : ""}`}
                title={collapsed ? item.label : undefined}
              >
                <span className="sidebar-link-icon">
                  <item.icon />
                </span>
                {!collapsed && <span className="sidebar-link-label">{item.label}</span>}
                {badge > 0 && (
                  <span className="sidebar-badge" title={`${badge} 个任务等待人工介入`}>
                    {collapsed ? "" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <HubIndicator status={hubStatus} collapsed={collapsed} />
          <div className="theme-toggle" role="group" aria-label="外观主题">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                title={opt.title}
                aria-label={opt.title}
                aria-pressed={theme === opt.key}
                className={theme === opt.key ? "active" : ""}
                onClick={() => setTheme(opt.key)}
              >
                <opt.icon />
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="content-pane">
        <main
          id="main-content"
          tabIndex={-1}
          className={`container${location.pathname === "/" ? " container--board" : ""}`}
        >
          <Routes>
            <Route path="/" element={<BoardPage />} />
            <Route path="/tasks/:id" element={<TaskPage />} />
            <Route path="/tasks/:id/nodes/:nodeId" element={<NodeEventsPage />} />
            <Route path="/repos" element={<Navigate to="/settings/repos" replace />} />
            <Route path="/instances" element={<InstancesPage />} />
            <Route path="/settings" element={<Navigate to="/settings/repos" replace />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>

      <CommandPalette
        open={ui.commandOpen}
        items={commandItems}
        onClose={() => ui.setCommandOpen(false)}
      />
      <ShortcutsHelp open={ui.helpOpen} onClose={() => ui.setHelpOpen(false)} />
    </div>
  );
}
