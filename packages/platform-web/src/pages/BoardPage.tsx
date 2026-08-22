import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, connectHub, type Repo, type Task, type TaskStatus } from "../api";

const COLUMNS: Array<{ key: TaskStatus | "active"; title: string; match: TaskStatus[] }> = [
  { key: "queued", title: "排队", match: ["queued", "preparing"] },
  { key: "running", title: "运行中", match: ["running", "delivering"] },
  { key: "waiting_human", title: "等人", match: ["waiting_human"] },
  { key: "done", title: "完成", match: ["done", "merged"] },
  { key: "failed", title: "失败", match: ["failed", "cancelled"] },
];

export function BoardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    repoId: "",
    title: "",
    requirement: "",
    pipeline: "",
  });

  const reload = async () => {
    const [t, r] = await Promise.all([api.listTasks(), api.listRepos()]);
    setTasks(t.tasks);
    setRepos(r.repos);
    if (!form.repoId && r.repos[0]) {
      setForm((f) => ({ ...f, repoId: r.repos[0]!.id }));
    }
  };

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const off = connectHub((msg) => {
      if (msg.type === "task.updated" && msg.payload) {
        const task = msg.payload as Task;
        setTasks((prev) => {
          const idx = prev.findIndex((x) => x.id === task.id);
          if (idx < 0) return [task, ...prev];
          const next = [...prev];
          next[idx] = task;
          return next;
        });
        if (task.status === "waiting_human" && "Notification" in window) {
          if (Notification.permission === "granted") {
            new Notification("codeloop: 需要人工介入", { body: task.title });
          } else if (Notification.permission !== "denied") {
            void Notification.requestPermission();
          }
        }
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (!form.repoId) {
      setPipelines([]);
      setForm((f) => ({ ...f, pipeline: "" }));
      setPipelinesLoading(false);
      return;
    }
    let cancelled = false;
    setPipelines([]);
    setForm((f) => ({ ...f, pipeline: "" }));
    setPipelinesLoading(true);
    setError(null);
    void api
      .getRepoConfig(form.repoId)
      .then((res) => {
        if (cancelled) return;
        setPipelines(res.pipelines);
        setForm((f) => ({ ...f, pipeline: res.config.pipeline }));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setPipelines([]);
        setForm((f) => ({ ...f, pipeline: "" }));
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPipelinesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.repoId]);

  const repoName = useMemo(() => {
    const m = new Map(repos.map((r) => [r.id, r.full_name]));
    return (id: string) => m.get(id) ?? id;
  }, [repos]);

  const pipelineOptions =
    form.pipeline && !pipelines.includes(form.pipeline) ? [form.pipeline, ...pipelines] : pipelines;

  const create = async () => {
    setError(null);
    try {
      await api.createTask({
        repoId: form.repoId,
        title: form.title || form.requirement.slice(0, 72),
        requirement: form.requirement,
        pipeline: form.pipeline || undefined,
      });
      setForm((f) => ({ ...f, title: "", requirement: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="Box">
        <div className="Box-header">
          <h2>手工创建任务</h2>
        </div>
        <div className="Box-body">
          <div className="row" style={{ marginBottom: 12 }}>
          <label>
            仓库
            <select
              value={form.repoId}
              onChange={(e) => setForm({ ...form, repoId: e.target.value })}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.full_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pipeline
            <select
              value={form.pipeline}
              onChange={(e) => setForm({ ...form, pipeline: e.target.value })}
              disabled={pipelinesLoading || !form.repoId || pipelineOptions.length === 0}
            >
              {pipelineOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            标题
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
        </div>
          <label style={{ marginBottom: 12 }}>
            需求
            <textarea
              value={form.requirement}
              onChange={(e) => setForm({ ...form, requirement: e.target.value })}
              placeholder="描述要实现的改动…"
            />
          </label>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void create()}
            disabled={!form.repoId || !form.requirement || !form.pipeline || pipelinesLoading}
          >
            入队
          </button>
          {pipelinesLoading && <p className="muted">加载 Pipeline…</p>}
          {error && <p className="error">{error}</p>}
          {!repos.length && (
            <p className="muted">还没有仓库，先去「仓库」页接入本地或 GitHub 仓库。</p>
          )}
        </div>
      </div>

      <div className="board">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => col.match.includes(t.status));
          return (
            <section key={col.key} className="board-column">
              <h3>
                <span>{col.title}</span>
                <span className="Counter">{items.length}</span>
              </h3>
              {items.map((t) => (
                <Link key={t.id} className="board-card" to={`/tasks/${t.id}`}>
                  <p className="title">{t.title}</p>
                  <div className="meta">
                    <span>{repoName(t.repo_id)}</span>
                    {t.issue_number != null && <span>#{t.issue_number}</span>}
                    {t.current_node && <span className="Label Label--accent">{t.current_node}</span>}
                    {t.branch && <span className="Label">{t.branch}</span>}
                  </div>
                  {t.error && (
                    <p className="board-card-error" title={t.error}>
                      {t.error}
                    </p>
                  )}
                </Link>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
