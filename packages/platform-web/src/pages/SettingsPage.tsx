import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { PageState, StatusBanner } from "../components/PageState";
import { api, type CodeloopConfig, type Repo } from "../api";

const STAGE_ALIASES = [
  { key: "planner", label: "规划" },
  { key: "planReviewer", label: "方案评审" },
  { key: "coder", label: "编码" },
  { key: "codeReviewer", label: "代码评审" },
  { key: "fixer", label: "修复" },
  { key: "verifier", label: "验证" },
  { key: "committer", label: "提交" },
] as const;

function withStages(config: CodeloopConfig): CodeloopConfig {
  const engines = { ...config.engines };
  for (const { key } of STAGE_ALIASES) {
    if (!engines[key]) engines[key] = { type: "cursor" };
  }
  return { ...config, engines };
}

export function SettingsPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [config, setConfig] = useState<CodeloopConfig | null>(null);
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [engineOptions, setEngineOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [bulkType, setBulkType] = useState("cursor");
  const [bulkModel, setBulkModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [r, meta] = await Promise.all([api.listRepos(), api.getConfigMeta()]);
        setRepos(r.repos);
        setEngineOptions(meta.engines);
        if (meta.engines[0]) setBulkType(meta.engines[0].id);
        if (r.repos.length === 1) setRepoId(r.repos[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

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
      const current = c.engines[key] ?? { type: "cursor" };
      return {
        ...c,
        engines: {
          ...c.engines,
          [key]: {
            ...current,
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
  const selectedRepo = repos.find((r) => r.id === repoId);

  return (
    <div className="page-stack">
      <PageHeader
        title="配置"
        description={
          selectedRepo
            ? `写入 ${selectedRepo.full_name} 的 .codeloop/config.yaml，只影响之后新建的任务。`
            : "按仓库写入 .codeloop/config.yaml，只影响之后新建的任务。"
        }
      />

      <div className="Box">
        <div className="Box-header">
          <h2>仓库</h2>
        </div>
        <div className="Box-body">
          {repos.length === 0 ? (
            <PageState kind="empty" title="还没有接入仓库">
              先到 <Link to="/repos">仓库</Link> 页添加。
            </PageState>
          ) : (
            <div className="form-grid">
              <label>
                仓库
                <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                  <option value="">选择仓库…</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      </div>

      {loading && <PageState kind="loading" title="加载配置中…" />}

      {config && (
        <>
          <div className="section-grid">
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
          </div>

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
        </>
      )}

      {!config && !loading && error && <StatusBanner kind="error">{error}</StatusBanner>}
    </div>
  );
}
