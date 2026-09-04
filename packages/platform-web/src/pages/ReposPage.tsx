import { useEffect, useState } from "react";
import { api, type Repo } from "../api";

type EditForm = {
  clonePath: string;
  triggerLabel: string;
  maxConcurrency: number;
  defaultBranch: string;
  githubToken: string;
};

export function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
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

  const startEdit = (r: Repo) => {
    setError(null);
    setEditingId(r.id);
    setEditForm({
      clonePath: r.clone_path,
      triggerLabel: r.trigger_label,
      maxConcurrency: r.max_concurrency,
      defaultBranch: r.default_branch,
      githubToken: "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    setSaving(true);
    setError(null);
    try {
      const token = editForm.githubToken.trim();
      await api.updateRepo(editingId, {
        clonePath: editForm.clonePath,
        triggerLabel: editForm.triggerLabel,
        maxConcurrency: editForm.maxConcurrency,
        defaultBranch: editForm.defaultBranch,
        ...(token ? { githubToken: token } : {}),
      });
      cancelEdit();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const editingRepo = editingId ? repos.find((r) => r.id === editingId) : undefined;

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
          {error && !editingId && <p className="error">{error}</p>}
        </div>
      </div>

      <div className="Box">
        <div className="Box-header">
          <h2>已接入</h2>
          <span className="Counter">{repos.length}</span>
        </div>
        {editingRepo && editForm && (
          <div className="Box-body">
            <p className="muted">
              编辑 <code>{editingRepo.full_name}</code>
              {editingRepo.platform ? ` · ${editingRepo.platform}` : ""}
            </p>
            <div className="row" style={{ marginBottom: 12 }}>
              <label>
                Full name
                <input value={editingRepo.full_name} readOnly disabled />
              </label>
              <label>
                Clone path
                <input
                  value={editForm.clonePath}
                  onChange={(e) => setEditForm({ ...editForm, clonePath: e.target.value })}
                />
              </label>
              <label>
                Trigger label
                <input
                  value={editForm.triggerLabel}
                  onChange={(e) => setEditForm({ ...editForm, triggerLabel: e.target.value })}
                />
              </label>
              <label>
                Max concurrency
                <input
                  type="number"
                  min={1}
                  value={editForm.maxConcurrency}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      maxConcurrency: Number(e.target.value) || 1,
                    })
                  }
                />
              </label>
              <label>
                Default branch
                <input
                  value={editForm.defaultBranch}
                  onChange={(e) => setEditForm({ ...editForm, defaultBranch: e.target.value })}
                />
              </label>
              <label>
                GitHub token
                <input
                  type="password"
                  value={editForm.githubToken}
                  onChange={(e) => setEditForm({ ...editForm, githubToken: e.target.value })}
                  placeholder="留空则不修改"
                  autoComplete="off"
                />
              </label>
            </div>
            {editingRepo.has_github_token && (
              <p className="muted" style={{ marginTop: 0 }}>
                已配置 token
              </p>
            )}
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                disabled={saving}
                onClick={() => void saveEdit()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
              <button className="btn" type="button" disabled={saving} onClick={cancelEdit}>
                取消
              </button>
            </div>
            {error && <p className="error">{error}</p>}
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
              <th>Label</th>
              <th>Concurrency</th>
              <th>Branch</th>
              <th>操作</th>
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
                <td>
                  <button className="btn" type="button" onClick={() => startEdit(r)}>
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
