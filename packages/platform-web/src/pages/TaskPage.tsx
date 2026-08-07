import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, connectHub, type Repo, type Task, type TaskEvent } from "../api";

export function TaskPage() {
  const { id = "" } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [kernel, setKernel] = useState<unknown>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [plan, setPlan] = useState<string | null>(null);
  const [injectText, setInjectText] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const detail = await api.getTask(id);
    setTask(detail.task);
    setRepo(detail.repo);
    setKernel(detail.kernel);
    const ev = await api.listEvents(id);
    setEvents(ev.events);
    try {
      setPlan(await api.artifact(id, "planDoc"));
    } catch {
      setPlan(null);
    }
  };

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const off = connectHub((msg) => {
      if (msg.type === "task.updated") {
        const t = msg.payload as Task;
        if (t.id === id) void reload();
      }
      if (msg.type === "task.event") {
        const p = msg.payload as { taskId: string };
        if (p.taskId === id) void reload();
      }
    });
    return off;
  }, [id]);

  const pendingReqId = (() => {
    const k = kernel as { pendingIntervention?: { requestId?: string } } | null;
    return k?.pendingIntervention?.requestId;
  })();

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!task) {
    return <p className="muted">{error ?? "加载中…"}</p>;
  }

  return (
    <>
      <p className="muted">
        <Link to="/">← 看板</Link>
      </p>
      <h1 className="issue-title">
        {task.title}
        <span className={`State ${stateClass(task.status)}`}>{task.status}</span>
      </h1>
      <div className="issue-meta">
        {repo && <span>{repo.full_name}</span>}
        {task.issue_number != null && repo && (
          <a
            href={`https://github.com/${repo.full_name}/issues/${task.issue_number}`}
            target="_blank"
            rel="noreferrer"
          >
            issue #{task.issue_number}
          </a>
        )}
        {task.pr_number != null && repo && (
          <a
            href={`https://github.com/${repo.full_name}/pull/${task.pr_number}`}
            target="_blank"
            rel="noreferrer"
          >
            PR #{task.pr_number}
          </a>
        )}
        {task.current_node && <span className="Label Label--accent">{task.current_node}</span>}
        {task.branch && <span className="Label">{task.branch}</span>}
        {task.kernel_task_id && <span>kernel={task.kernel_task_id}</span>}
      </div>

      <div className="Box">
        <div className="Box-header">
          <h2>操作</h2>
        </div>
        <div className="Box-body">
          <div className="row">
            <button className="btn" type="button" onClick={() => void act(() => api.pause(task.id))}>
              Pause
            </button>
            <button className="btn" type="button" onClick={() => void act(() => api.resume(task.id))}>
              Resume
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => void act(() => api.abort(task.id))}
            >
              Abort
            </button>
            <button className="btn" type="button" onClick={() => void act(() => api.cancel(task.id))}>
              Cancel
            </button>
            <button className="btn" type="button" onClick={() => void act(() => api.retry(task.id))}>
              Retry
            </button>
          </div>
          {task.error && <p className="error">{task.error}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      </div>

      <div className="grid-2">
        <div className="Box">
          <div className="Box-header">
            <h2>介入</h2>
          </div>
          <div className="Box-body">
            {pendingReqId ? (
              <div className="row" style={{ marginBottom: 12 }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() =>
                    void act(() => api.intervene(task.id, pendingReqId, { action: "approve" }))
                  }
                >
                  Approve
                </button>
                <input
                  placeholder="驳回意见"
                  value={rejectText}
                  onChange={(e) => setRejectText(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() =>
                    void act(() =>
                      api.intervene(task.id, pendingReqId, {
                        action: "reject",
                        comments: [
                          {
                            id: "web-reject",
                            severity: "major",
                            comment: rejectText || "Rejected",
                            status: "open",
                          },
                        ],
                      }),
                    )
                  }
                >
                  Reject
                </button>
              </div>
            ) : (
              <p className="muted">当前无待处理审批门</p>
            )}
            <div className="row">
              <input
                style={{ flex: 1 }}
                placeholder="注入指令…"
                value={injectText}
                onChange={(e) => setInjectText(e.target.value)}
              />
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void act(async () => {
                    await api.inject(task.id, injectText);
                    setInjectText("");
                  })
                }
              >
                Inject
              </button>
            </div>
          </div>
        </div>

        <div className="Box">
          <div className="Box-header">
            <h2>需求</h2>
          </div>
          <div className="Box-body">
            <pre className="artifact">{task.requirement}</pre>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="Box">
          <div className="Box-header">
            <h2>事件时间线</h2>
          </div>
          <div className="Box-body">
            <ul className="timeline">
              {[...events].reverse().map((e) => (
                <li key={`${e.seq}`}>
                  <span className={`dot ${dotClass(e.type)}`} />
                  <span className="ts">{e.ts.slice(11, 19)}</span>
                  <strong>{e.type}</strong>{" "}
                  <span className="muted">{summarize(e)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="Box">
          <div className="Box-header">
            <h2>计划产物</h2>
          </div>
          <div className="Box-body">
            {plan ? <pre className="artifact">{plan}</pre> : <p className="muted">暂无 planDoc</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function stateClass(status: Task["status"]): string {
  switch (status) {
    case "running":
    case "delivering":
      return "State--running";
    case "waiting_human":
      return "State--waiting";
    case "done":
      return "State--done";
    case "failed":
    case "cancelled":
      return "State--failed";
    default:
      return "State--queued";
  }
}

function dotClass(type: string): string {
  if (type === "node.completed" || type === "task.completed") return "dot--success";
  if (type === "task.failed") return "dot--danger";
  if (type === "node.started") return "dot--accent";
  if (type === "intervention.required") return "dot--attention";
  return "";
}

function summarize(e: TaskEvent): string {
  try {
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (e.type === "node.started" || e.type === "node.completed") return String(p.nodeId ?? "");
    if (e.type === "intervention.required") return String(p.summary ?? p.kind ?? "");
    if (e.type === "loop.iteration") return `${p.loopId} ${p.iteration}/${p.maxIterations}`;
    if (e.type === "task.failed") return String(p.error ?? "");
    return "";
  } catch {
    return "";
  }
}
