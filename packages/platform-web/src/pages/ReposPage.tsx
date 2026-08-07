import { useEffect, useState } from "react";
import { api, type Repo } from "../api";

export function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    fullName: "",
    clonePath: "",
    triggerLabel: "ai-dev",
    maxConcurrency: 1,
    defaultBranch: "main",
  });

  const reload = () => api.listRepos().then((r) => setRepos(r.repos));

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
  }, []);

  const create = async () => {
    setError(null);
    try {
      await api.createRepo({
        fullName: form.fullName,
        clonePath: form.clonePath || undefined,
        triggerLabel: form.triggerLabel,
        maxConcurrency: form.maxConcurrency,
        defaultBranch: form.defaultBranch,
      });
      setForm((f) => ({ ...f, fullName: "", clonePath: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="Box">
        <div className="Box-header">
          <h2>接入仓库</h2>
        </div>
        <div className="Box-body">
          <p className="muted">
            GitHub 仓库填 <code>owner/name</code>；本地仓库可把 Clone Path 指到已有 git
            目录（手工任务可不依赖 GitHub token）。
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
          <label>
            Full name
            <input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              placeholder="owner/repo 或 local/my-app"
            />
          </label>
          <label>
            Clone path
            <input
              value={form.clonePath}
              onChange={(e) => setForm({ ...form, clonePath: e.target.value })}
              placeholder="/abs/path/to/repo（可选）"
            />
          </label>
          <label>
            Trigger label
            <input
              value={form.triggerLabel}
              onChange={(e) => setForm({ ...form, triggerLabel: e.target.value })}
            />
          </label>
          <label>
            Max concurrency
            <input
              type="number"
              min={1}
              value={form.maxConcurrency}
              onChange={(e) =>
                setForm({ ...form, maxConcurrency: Number(e.target.value) || 1 })
              }
            />
          </label>
          <label>
            Default branch
            <input
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
            />
          </label>
        </div>
          <button className="btn btn-primary" type="button" onClick={() => void create()}>
            添加
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      </div>

      <div className="Box">
        <div className="Box-header">
          <h2>已接入</h2>
          <span className="Counter">{repos.length}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
              <th>Label</th>
              <th>Concurrency</th>
              <th>Branch</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.id}>
                <td>{r.full_name}</td>
                <td className="muted">{r.clone_path}</td>
                <td>
                  <span className="Label Label--accent">{r.trigger_label}</span>
                </td>
                <td>{r.max_concurrency}</td>
                <td className="muted">{r.default_branch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
