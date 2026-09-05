import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { PageState, StatusBanner } from "../components/PageState";
import { api, type CodeloopConfig, type Repo } from "../api";
import { ReposPage } from "./ReposPage";

const STAGE_ALIASES = [
  { key: "planner", label: "规划" },
  { key: "planReviewer", label: "方案评审" },
  { key: "coder", label: "编码" },
  { key: "codeReviewer", label: "代码评审" },
  { key: "fixer", label: "修复" },
  { key: "verifier", label: "验证" },
  { key: "committer", label: "提交" },
] as const;

const SETTINGS_SECTIONS = [
  {
    id: "repos",
    label: "仓库",
    title: "仓库",
    description: "接入本地目录或 GitHub 仓库后即可创建任务。",
  },
  {
    id: "pipeline",
    label: "流水线",
    title: "流水线",
    description: "默认 pipeline 与门禁行为，只影响之后新建的任务。",
  },
  {
    id: "workspace",
    label: "工作区",
    title: "工作区",
    description: "Worktree / Inplace 与分支命名。",
  },
  {
    id: "agents",
    label: "智能体",
    title: "智能体",
    description: "各阶段使用的引擎与模型。",
  },
  {
    id: "budget",
    label: "预算",
    title: "预算",
    description: "引擎调用次数与节点超时。",
  },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

function isSettingsSection(value: string | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

function withStages(config: CodeloopConfig): CodeloopConfig {
  const engines = { ...config.engines };
  for (const { key } of STAGE_ALIASES) {
    if (!engines[key]) engines[key] = { type: "cursor" };
  }
  return { ...config, engines };
}

function sectionHref(id: SettingsSectionId, repoId: string) {
  if (id === "repos" || !repoId) return `/settings/${id}`;
  return `/settings/${id}?repo=${encodeURIComponent(repoId)}`;
}

export function SettingsPage() {
  const { section } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState(searchParams.get("repo") ?? "");
  const [config, setConfig] = useState<CodeloopConfig | null>(null);
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [engineOptions, setEngineOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [bulkType, setBulkType] = useState("cursor");
  const [bulkModel, setBulkModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = isSettingsSection(section)
    ? SETTINGS_SECTIONS.find((s) => s.id === section)!
    : SETTINGS_SECTIONS[0];
  const isConfigSection = current.id !== "repos";
  const selectedRepo = repos.find((r) => r.id === repoId);

  useEffect(() => {
    void (async () => {
      try {
        const [r, meta] = await Promise.all([api.listRepos(), api.getConfigMeta()]);
        setRepos(r.repos);
        setEngineOptions(meta.engines);
        if (meta.engines[0]) setBulkType(meta.engines[0].id);
        setRepoId((currentId) => {
          if (currentId && r.repos.some((repo) => repo.id === currentId)) return currentId;
          return r.repos.length === 1 ? r.repos[0].id : "";
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const urlRepo = searchParams.get("repo") ?? "";

  useEffect(() => {
    if (urlRepo && urlRepo !== repoId) setRepoId(urlRepo);
    // Follow the URL only when the query itself changes (back/forward, sidenav).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlRepo]);

  const selectRepo = (id: string) => {
    setRepoId(id);
    setSaved(false);
    if (!isConfigSection) return;
    const next = new URLSearchParams(searchParams);
    if (id) next.set("repo", id);
    else next.delete("repo");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (!repoId) {
      setConfig(null);
      setPipelines([]);
      return;
    }
    setLoading(true);
    setSaved(false);
    setError(null);
    void api
      .getRepoConfig(repoId)
      .then((res) => {
        setConfig(withStages(res.config));
        setPipelines(res.pipelines);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [repoId]);

  const update = (patch: Partial<CodeloopConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    setSaved(false);
  };

  const setEngine = (key: string, field: "type" | "model", value: string) => {
    setConfig((c) => {
      if (!c) return c;
      const currentEngine = c.engines[key] ?? { type: "cursor" };
      return {
        ...c,
        engines: {
          ...c.engines,
          [key]: {
            ...currentEngine,
            [field]: value,
          },
        },
      };
    });
    setSaved(false);
  };

  const applyBulk = () => {
    setConfig((c) => {
      if (!c) return c;
      const engines = { ...c.engines };
      for (const { key } of STAGE_ALIASES) {
        engines[key] = {
          type: bulkType,
          ...(bulkModel.trim() ? { model: bulkModel.trim() } : {}),
        };
      }
      return { ...c, engines };
    });
    setSaved(false);
  };

  const save = async () => {
    if (!repoId || !config) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: CodeloopConfig = {
        ...config,
        version: 1,
        engines: Object.fromEntries(
          Object.entries(config.engines).map(([key, value]) => [
            key,
            {
              type: value.type,
              ...(value.model?.trim() ? { model: value.model.trim() } : {}),
            },
          ]),
        ),
      };
      const res = await api.putRepoConfig(repoId, body);
      setConfig(withStages(res.config));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const pipelineOptions =
    config && !pipelines.includes(config.pipeline) ? [config.pipeline, ...pipelines] : pipelines;

  const description =
    current.id === "repos"
      ? `${repos.length} 个已接入 · ${current.description}`
      : selectedRepo
        ? `写入 ${selectedRepo.full_name} 的 .codeloop/config.yaml。${current.description}`
        : current.description;

  if (!isSettingsSection(section)) {
    return <Navigate to="/settings/repos" replace />;
  }

  return (
    <div className="settings-layout">
      <nav className="settings-sidenav" aria-label="配置分组">
        {SETTINGS_SECTIONS.map((item) => (
          <NavLink
            key={item.id}
            to={sectionHref(item.id, repoId)}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            <span>{item.label}</span>
            {item.id === "repos" && repos.length > 0 && (
              <span className="Counter">{repos.length}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="settings-main">
        <PageHeader
          title={
            isConfigSection && selectedRepo
              ? `${current.title} · ${selectedRepo.full_name}`
              : current.title
          }
          description={description}
          actions={
            isConfigSection && repos.length > 0 ? (
              <label className="settings-repo-pick">
                仓库
                <select value={repoId} onChange={(e) => selectRepo(e.target.value)}>
                  <option value="">选择仓库…</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </label>
            ) : undefined
          }
        />

        {current.id === "repos" && (
          <ReposPage
            onReposChange={(next) => {
              setRepos(next);
              setRepoId((currentId) => {
                if (currentId && next.some((repo) => repo.id === currentId)) return currentId;
                return next.length === 1 ? next[0].id : currentId;
              });
            }}
          />
        )}

        {isConfigSection && repos.length === 0 && (
          <div className="Box">
            <div className="Box-body">
              <PageState kind="empty" title="还没有接入仓库">
                先到 <Link to="/settings/repos">仓库</Link> 添加。
              </PageState>
            </div>
          </div>
        )}

        {isConfigSection && repos.length > 0 && !repoId && (
          <div className="Box">
            <div className="Box-body">
              <PageState kind="empty" title="选择一个仓库">
                用右上角的仓库选择器，再编辑该仓库的配置。
              </PageState>
            </div>
          </div>
        )}

        {isConfigSection && loading && <PageState kind="loading" title="加载配置中…" />}

        {isConfigSection && config && (
          <div className="page-stack">
            {current.id === "pipeline" && (
              <div className="Box">
                <div className="Box-header">
                  <h2>流水线</h2>
                </div>
                <div className="Box-body">
                  <div className="form-grid">
                    <label>
                      Pipeline
                      <select
                        value={config.pipeline}
                        onChange={(e) => update({ pipeline: e.target.value })}
                      >
                        {pipelineOptions.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="check-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={config.autoApproveGates}
                        onChange={(e) => update({ autoApproveGates: e.target.checked })}
                      />
                      自动批准门禁（autoApproveGates）
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={config.skipVerifyIfMissing}
                        onChange={(e) => update({ skipVerifyIfMissing: e.target.checked })}
                      />
                      缺少 verify 配置时跳过
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={config.sandbox}
                        onChange={(e) => update({ sandbox: e.target.checked })}
                      />
                      写操作启用 sandbox
                    </label>
                  </div>
                </div>
              </div>
            )}

            {current.id === "workspace" && (
              <div className="Box">
                <div className="Box-header">
                  <h2>工作区</h2>
                </div>
                <div className="Box-body">
                  <div className="check-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!config.inplace}
                        onChange={(e) => update({ inplace: !e.target.checked })}
                      />
                      使用 Worktree 模式
                    </label>
                  </div>
                  {!config.inplace && (
                    <div className="form-grid">
                      <label>
                        分支前缀
                        <input
                          value={config.git.branchPrefix}
                          onChange={(e) =>
                            update({ git: { ...config.git, branchPrefix: e.target.value } })
                          }
                        />
                      </label>
                      <label>
                        Worktree 根目录
                        <input
                          value={config.git.worktreeRoot}
                          onChange={(e) =>
                            update({ git: { ...config.git, worktreeRoot: e.target.value } })
                          }
                        />
                      </label>
                    </div>
                  )}
                  {config.inplace && (
                    <p className="muted">
                      Inplace 模式在仓库本身工作，提交落在当前分支，且不对工作区做{" "}
                      <code>reset --hard</code> / <code>clean -fd</code>。
                    </p>
                  )}
                </div>
              </div>
            )}

            {current.id === "agents" && (
              <div className="Box">
                <div className="Box-header">
                  <h2>智能体</h2>
                </div>
                <div className="Box-body">
                  <p className="muted">
                    模型 id 可空（用引擎默认）。可用 <code>agent --list-models</code> 或{" "}
                    <code>opencode models</code> 查看。
                  </p>
                  <div className="form-grid">
                    <label>
                      智能体
                      <select value={bulkType} onChange={(e) => setBulkType(e.target.value)}>
                        {engineOptions.map((eng) => (
                          <option key={eng.id} value={eng.id}>
                            {eng.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      模型
                      <input
                        value={bulkModel}
                        onChange={(e) => setBulkModel(e.target.value)}
                        placeholder="可选"
                      />
                    </label>
                  </div>
                  <div className="action-bar">
                    <button className="btn" type="button" onClick={applyBulk}>
                      应用到全部阶段
                    </button>
                  </div>
                  <div className="table-scroll">
                    <table className="engine-table">
                      <thead>
                        <tr>
                          <th>阶段</th>
                          <th>智能体</th>
                          <th>模型</th>
                        </tr>
                      </thead>
                      <tbody>
                        {STAGE_ALIASES.map((stage) => {
                          const engine = config.engines[stage.key] ?? { type: "cursor" };
                          return (
                            <tr key={stage.key}>
                              <td>
                                {stage.label}
                                <span className="muted"> {stage.key}</span>
                              </td>
                              <td>
                                <select
                                  value={engine.type}
                                  onChange={(e) => setEngine(stage.key, "type", e.target.value)}
                                >
                                  {engineOptions.map((eng) => (
                                    <option key={eng.id} value={eng.id}>
                                      {eng.label}
                                    </option>
                                  ))}
                                  {!engineOptions.some((eng) => eng.id === engine.type) && (
                                    <option value={engine.type}>{engine.type}</option>
                                  )}
                                </select>
                              </td>
                              <td>
                                <input
                                  value={engine.model ?? ""}
                                  onChange={(e) => setEngine(stage.key, "model", e.target.value)}
                                  placeholder="引擎默认"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {current.id === "budget" && (
              <div className="Box">
                <div className="Box-header">
                  <h2>预算</h2>
                </div>
                <div className="Box-body">
                  <div className="form-grid">
                    <label>
                      最大引擎调用次数
                      <input
                        type="number"
                        min={1}
                        value={config.budget.maxEngineCalls}
                        onChange={(e) =>
                          update({
                            budget: {
                              ...config.budget,
                              maxEngineCalls: Number(e.target.value) || 1,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      节点超时（分钟）
                      <input
                        type="number"
                        min={1}
                        value={config.budget.nodeTimeoutMinutes}
                        onChange={(e) =>
                          update({
                            budget: {
                              ...config.budget,
                              nodeTimeoutMinutes: Number(e.target.value) || 1,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            <div className="sticky-actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
              {saved && <StatusBanner kind="success">已保存</StatusBanner>}
              {error && <StatusBanner kind="error">{error}</StatusBanner>}
            </div>
          </div>
        )}

        {isConfigSection && !config && !loading && error && (
          <StatusBanner kind="error">{error}</StatusBanner>
        )}
      </div>
    </div>
  );
}
