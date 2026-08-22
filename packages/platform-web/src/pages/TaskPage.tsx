import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  parseStoredKernelEvents,
  taskActionsEnabled,
} from "@devtools/shared";
import { Markdown } from "../components/Markdown";
import {
  api,
  connectHub,
  type KernelTaskSnapshot,
  type Repo,
  type StageExecution,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from "../api";

function detailFromEvents(task: Task, repo: Repo | null, events: TaskEvent[]): TaskDetail {
  return buildTaskDetail(
    {
      taskId: task.kernel_task_id ?? task.id,
      requirement: task.requirement,
      status: kernelStatusFromPlatform(task.status),
      currentNode: task.current_node,
      error: task.error,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      pipeline: { name: task.pipeline_name ?? "", hash: "" },
      git: {
        repoPath: repo?.clone_path ?? "",
        worktreePath: "",
        branch: task.branch ?? "",
        baseCommit: "",
      },
      artifacts: [],
      pendingIntervention: null,
    },
    parseStoredKernelEvents(events),
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [kernel, setKernel] = useState<KernelTaskSnapshot | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  const [injectText, setInjectText] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [editingPlan, setEditingPlan] = useState(false);
  const [editText, setEditText] = useState("");
  const [planDoc, setPlanDoc] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadDetail = async () => {
    const info = await api.getTask(id);
    setTask(info.task);
    setRepo(info.repo);
    setKernel(info.kernel);
    const ev = await api.listEvents(id);
    setEvents(ev.events);
    try {
      const d = await api.getDetail(id);
      setDetail(d.detail.stages.length > 0 ? d.detail : detailFromEvents(info.task, info.repo, ev.events));
    } catch {
      // 内核已释放：用平台落库的事件重折阶段，避免退化成节点平铺
      setDetail(detailFromEvents(info.task, info.repo, ev.events));
    }
  };

  const loadArtifact = async (key: string) => {
    try {
      setPreview({ key, text: await api.artifact(id, key) });
    } catch (e) {
      setPreview({ key, text: `读取失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  useEffect(() => {
    setPreview(null);
    setDetail(null);
    setPlanDoc(null);
    setPlanError(null);
    void reloadDetail().catch((e: Error) => setError(e.message));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDetail = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reloadDetail().catch(() => undefined);
      }, 400);
    };

    const off = connectHub((msg) => {
      if (msg.type === "task.updated") {
        const t = msg.payload as Task;
        if (t.id === id) {
          setTask(t);
          scheduleDetail();
        }
      }
      if (msg.type === "task.event") {
        const p = msg.payload as {
          taskId: string;
          event?: { type?: string; seq?: number; ts?: string; payload?: unknown };
        };
        if (p.taskId !== id) return;
        if (p.event?.seq != null && p.event.type) {
          const row: TaskEvent = {
            task_id: id,
            seq: p.event.seq,
            ts: p.event.ts ?? new Date().toISOString(),
            type: p.event.type,
            payload:
              typeof p.event.payload === "string"
                ? p.event.payload
                : JSON.stringify(p.event.payload ?? {}),
          };
          setEvents((prev) => (prev.some((e) => e.seq === row.seq) ? prev : [...prev, row]));
        }
        // 详情按节点边界重取，避免事件风暴打满内核
        if (
          p.event?.type === "node.started" ||
          p.event?.type === "node.completed" ||
          p.event?.type === "task.completed" ||
          p.event?.type === "task.failed"
        ) {
          scheduleDetail();
        }
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [id]);

  const pendingReqId = kernel?.pendingIntervention?.requestId;
  const pendingIsLimit = kernel?.pendingIntervention?.kind === "limit";
  const hasPendingIntervention = !!pendingReqId;
  const bound = !!(task?.instance_id && task?.kernel_task_id);
  const kernelStatus = kernel?.task?.status ?? null;
  const actions = task
    ? taskActionsEnabled({
        status: task.status,
        bound,
        kernelStatus,
        hasPendingIntervention,
      })
    : null;

  const loadPlanDoc = useCallback(async () => {
    if (!id) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const text = await api.artifact(id, "planDoc");
      setPlanDoc(text.trim() ? text : null);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
      setPlanDoc(null);
    } finally {
      setPlanLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (pendingReqId) void loadPlanDoc();
    else setEditingPlan(false);
  }, [pendingReqId, loadPlanDoc]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reloadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!task || !actions) {
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
            <button
              className="btn"
              type="button"
              disabled={!actions.pause}
              onClick={() => void act(() => api.pause(task.id))}
            >
              Pause
            </button>
            <button
              className="btn"
              type="button"
              disabled={!actions.resume}
              onClick={() => void act(() => api.resume(task.id))}
            >
              Resume
            </button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={!actions.abort}
              onClick={() => void act(() => api.abort(task.id))}
            >
              Abort
            </button>
            <button
              className="btn"
              type="button"
              disabled={!actions.cancel}
              onClick={() => void act(() => api.cancel(task.id))}
            >
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={!actions.retry}
              onClick={() => void act(() => api.retry(task.id))}
            >
              Retry
            </button>
          </div>
          {task.error && (task.status === "failed" || task.status === "cancelled") && (
            <p className="error">{task.error}</p>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      </div>

      {detail && <Overview detail={detail} />}

      <div className="grid-2">
        <div className="Box">
          <div className="Box-header">
            <h2>介入</h2>
          </div>
          <div className="Box-body">
            {pendingReqId ? (
              <>
                <div className="plan-panel">
                  <div className="row" style={{ marginBottom: 8 }}>
                    <strong style={{ flex: 1 }}>
                      {pendingIsLimit ? "循环已达上限" : "审阅计划 (planDoc)"}
                    </strong>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void loadPlanDoc()}
                      disabled={planLoading}
                    >
                      {planLoading ? "加载中…" : "刷新"}
                    </button>
                  </div>
                  {planLoading ? (
                    <p className="muted">加载计划中…</p>
                  ) : editingPlan ? (
                    <div className="plan-doc">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={18}
                        style={{ width: "100%", fontFamily: "monospace" }}
                      />
                      <div className="row" style={{ marginTop: 8 }}>
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={!actions.edit || !editText.trim()}
                          onClick={() =>
                            void act(async () => {
                              await api.intervene(task.id, pendingReqId, {
                                action: "edit",
                                content: editText,
                              });
                              setEditingPlan(false);
                            })
                          }
                        >
                          保存并 Approve
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => setEditingPlan(false)}
                        >
                          取消编辑
                        </button>
                      </div>
                    </div>
                  ) : planDoc ? (
                    <div className="plan-doc">
                      <Markdown content={planDoc} />
                    </div>
                  ) : (
                    <p className="muted">
                      {planError ? `planDoc 读取失败: ${planError}` : "暂无 planDoc"}
                    </p>
                  )}
                </div>
                {pendingIsLimit && (
                  <p className="muted" style={{ marginBottom: 8 }}>
                    {kernel?.pendingIntervention?.summary ?? "循环已达最大次数。"} Approve
                    将带着当前结果继续后续步骤，Reject 则保持挂起。
                  </p>
                )}
                <div className="row" style={{ marginBottom: 12 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!actions.approve}
                    onClick={() =>
                      void act(() => api.intervene(task.id, pendingReqId, { action: "approve" }))
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={!actions.edit}
                    onClick={() => {
                      setEditText(planDoc ?? "");
                      setEditingPlan(true);
                    }}
                  >
                    编辑计划…
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
                    disabled={!actions.reject}
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
              </>
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
                disabled={!actions.inject}
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

      <div className="Box">
        <div className="Box-header">
          <h2>阶段时间线</h2>
          {detail && <span className="Counter">{detail.stages.length}</span>}
        </div>
        <div className="Box-body">
          {detail && detail.stages.length > 0 ? (
            detail.stages.map((stage) => (
              <StageCard
                key={stage.index}
                stage={stage}
                events={events}
                onArtifact={(key) => void loadArtifact(key)}
              />
            ))
          ) : (
            <EventTimeline events={events} />
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="Box">
          <div className="Box-header">
            <h2>交付件</h2>
          </div>
          <div className="Box-body">
            {detail && detail.artifacts.length > 0 ? (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>交付件</th>
                      <th>产出节点</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.artifacts.map((a) => (
                      <tr key={a.key}>
                        <td>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => void loadArtifact(a.key)}
                          >
                            {a.key}.{a.ext}
                          </button>{" "}
                          <span className="muted">{fmtBytes(a.size)}</span>
                        </td>
                        <td className="muted">{a.producedByNodeId ?? "—"}</td>
                        <td className="muted">{fmtClock(a.mtime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview && (
                  <>
                    <p className="muted" style={{ margin: "12px 0 6px" }}>
                      {preview.key}
                    </p>
                    <pre className="artifact">{prettyJson(preview.text)}</pre>
                  </>
                )}
              </>
            ) : (
              <p className="muted">暂无交付件</p>
            )}
          </div>
        </div>

        <div className="Box">
          <div className="Box-header">
            <h2>提交与介入</h2>
          </div>
          <div className="Box-body">
            <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>提交</h3>
            {detail && detail.commits.length > 0 ? (
              <ul className="plain">
                {detail.commits.map((c) => (
                  <li key={c.sha}>
                    {repo ? (
                      <a
                        href={`https://github.com/${repo.full_name}/commit/${c.sha}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>{c.sha.slice(0, 8)}</code>
                      </a>
                    ) : (
                      <code>{c.sha.slice(0, 8)}</code>
                    )}{" "}
                    {c.message.split("\n")[0]}
                    {c.nodeId && <span className="muted"> · {c.nodeId}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">暂无提交</p>
            )}
            <h3 style={{ fontSize: 13, margin: "16px 0 8px" }}>介入记录</h3>
            {detail && detail.interventions.length > 0 ? (
              <ul className="plain">
                {detail.interventions.map((i) => (
                  <li key={i.requestId}>
                    <span className="Label">{i.kind}</span> {i.nodeId} — {i.summary}
                    <span className="muted">
                      {" "}
                      → {i.decision?.action ?? "待处理"}
                      {i.waitedMs != null ? ` (等待 ${fmtDuration(i.waitedMs)})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">全程无人工介入</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Overview({ detail }: { detail: TaskDetail }) {
  const rows: Array<[string, React.ReactNode]> = [
    ["pipeline", `${detail.pipeline.name} (${detail.pipeline.hash.slice(0, 12)})`],
    ["worktree", detail.git.worktreePath],
    [
      "commit",
      `${detail.git.baseCommit.slice(0, 8) || "—"} → ${detail.git.head?.slice(0, 8) ?? "—"}${
        detail.git.dirty ? " (有未提交改动)" : ""
      }`,
    ],
    [
      "耗时",
      `${fmtDuration(detail.durationMs)} · ${fmtClock(detail.startedAt)} → ${
        detail.endedAt ? fmtClock(detail.endedAt) : "进行中"
      }`,
    ],
    [
      "引擎用量",
      `${detail.usage.turns} turns · in ${detail.usage.inputTokens} / out ${detail.usage.outputTokens}`,
    ],
    ["事件", `${detail.eventCount} 条 (seq ≤ ${detail.lastSeq})`],
  ];
  return (
    <div className="Box">
      <div className="Box-header">
        <h2>过程概览</h2>
      </div>
      <div className="Box-body">
        <dl className="kv-grid">
          {rows.map(([k, v]) => (
            <div key={k} className="kv-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {detail.error && (detail.status === "failed" || detail.status === "aborted") && (
          <p className="error">{detail.error}</p>
        )}
      </div>
    </div>
  );
}

function StageCard({
  stage,
  events,
  onArtifact,
}: {
  stage: StageExecution;
  events: TaskEvent[];
  onArtifact: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const slice = open
    ? events.filter((e) => e.seq >= stage.eventRange.from && e.seq <= stage.eventRange.to)
    : [];

  return (
    <div className={`stage stage--${stage.status}`}>
      <button className="stage-head" type="button" onClick={() => setOpen(!open)}>
        <span className="muted">#{stage.index}</span>
        <strong>{stage.nodeId}</strong>
        <span className="Label">{stage.primitive}</span>
        {stage.loopLabel && <span className="Label">{stage.loopLabel}</span>}
        {stage.nodeRun > 1 && <span className="Label">第 {stage.nodeRun} 次</span>}
        {stage.engine && (
          <span className="muted">
            {stage.engine}
            {stage.model ? ` / ${stage.model}` : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {stage.artifacts.length > 0 && (
          <span className="muted">{stage.artifacts.length} 交付件</span>
        )}
        <span className="muted">{fmtDuration(stage.durationMs)}</span>
        <span className={`Label ${stageLabelClass(stage.status)}`}>{stage.status}</span>
      </button>
      {open && (
        <div className="stage-body">
          {stage.error && <p className="error">{stage.error}</p>}
          {outcomeSummary(stage.outcome) && (
            <p>
              <span className="muted">结果 </span>
              {outcomeSummary(stage.outcome)}
            </p>
          )}
          {stage.artifacts.length > 0 && (
            <p>
              <span className="muted">交付件 </span>
              {stage.artifacts.map((a) => (
                <button
                  key={a.key}
                  className="btn"
                  type="button"
                  style={{ marginRight: 6 }}
                  onClick={() => onArtifact(a.key)}
                >
                  {a.key}
                  {a.ext ? `.${a.ext}` : ""}
                </button>
              ))}
            </p>
          )}
          {stage.commits.length > 0 && (
            <p>
              <span className="muted">提交 </span>
              {stage.commits.map((c) => (
                <code key={c.sha} style={{ marginRight: 6 }}>
                  {c.sha.slice(0, 8)} {c.message.split("\n")[0]}
                </code>
              ))}
            </p>
          )}
          {stage.filesChanged.length > 0 && (
            <p>
              <span className="muted">改动文件 </span>
              {stage.filesChanged.join(", ")}
            </p>
          )}
          {stage.retries.length > 0 && (
            <p className="error">
              重试 {stage.retries.map((r) => `#${r.attempt} ${r.error}`).join("; ")}
            </p>
          )}
          <p className="muted">
            {stage.usage
              ? `${stage.usage.turns} turns · in ${stage.usage.inputTokens} / out ${stage.usage.outputTokens} · `
              : ""}
            {stage.toolUseCount ? `${stage.toolUseCount} 次工具调用 · ` : ""}
            seq {stage.eventRange.from}–{stage.eventRange.to}
          </p>
          <EventTimeline events={slice} />
        </div>
      )}
    </div>
  );
}

function EventTimeline({ events }: { events: TaskEvent[] }) {
  if (!events.length) return <p className="muted">该区间无事件记录</p>;
  const chronological = [...events].sort((a, b) => a.seq - b.seq);
  return (
    <ul className="timeline">
      {chronological.map((e) => (
        <li key={`${e.seq}`}>
          <span className={`dot ${dotClass(e.type)}`} />
          <span className="ts">{fmtClock(e.ts)}</span>
          <strong>{e.type}</strong> <span className="muted">{summarize(e)}</span>
        </li>
      ))}
    </ul>
  );
}

function outcomeSummary(outcome: Record<string, unknown> | undefined): string {
  if (!outcome) return "";
  const parts: string[] = [];
  const push = (cond: boolean, text: string) => {
    if (cond) parts.push(text);
  };
  push(outcome.passed != null, `passed=${String(outcome.passed)}`);
  push(outcome.commentCount != null, `comments=${String(outcome.commentCount)}`);
  push(outcome.approved != null, `approved=${String(outcome.approved)}`);
  push(outcome.rejected === true, "rejected");
  push(outcome.skipped === true, "skipped");
  push(typeof outcome.sha === "string", `sha=${String(outcome.sha).slice(0, 8)}`);
  if (Array.isArray(outcome.filesChanged)) parts.push(`files=${outcome.filesChanged.length}`);
  if (Array.isArray(outcome.failures) && outcome.failures.length) {
    parts.push(`failures=${outcome.failures.length}`);
  }
  if (typeof outcome.summary === "string" && outcome.summary) parts.push(outcome.summary);
  return parts.join(" · ");
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtClock(iso: string | undefined): string {
  return iso ? iso.slice(11, 19) : "—";
}

function stageLabelClass(status: StageExecution["status"]): string {
  switch (status) {
    case "completed":
      return "Label--success";
    case "failed":
    case "aborted":
      return "Label--danger";
    case "waiting":
      return "Label--attention";
    default:
      return "Label--accent";
  }
}

function stateClass(status: Task["status"]): string {
  switch (status) {
    case "running":
    case "delivering":
      return "State--running";
    case "waiting_human":
      return "State--waiting";
    case "done":
    case "merged":
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
    if (e.type === "intervention.resolved") {
      const d = p.decision as { action?: string } | undefined;
      return String(d?.action ?? "");
    }
    if (e.type === "loop.iteration") return `${p.loopId} ${p.iteration}/${p.maxIterations}`;
    if (e.type === "artifact.created") return String(p.key ?? "");
    if (e.type === "git.commit") return `${String(p.sha ?? "").slice(0, 8)} ${String(p.message ?? "").split("\n")[0]}`;
    if (e.type === "log") return String(p.message ?? "");
    if (e.type === "task.failed") return String(p.error ?? "");
    return "";
  } catch {
    return "";
  }
}
