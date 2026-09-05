import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  buildWorkflowView,
  countWorkflowNodes,
  taskActionsEnabled,
  type TaskControlAction,
} from "@devtools/shared";
import { ArtifactPreview } from "../components/ArtifactPreview";
import { Markdown } from "../components/Markdown";
import { PageHeader } from "../components/PageHeader";
import { PageState, Skeleton, StatusBanner } from "../components/PageState";
import { useToast } from "../components/Toast";
import { useTaskStore } from "../task-store";
import { useUi } from "../ui-store";
import { useKeyBindings } from "../shortcuts";
import {
  api,
  type Repo,
  type Task,
  type TaskDetail,
  type WorkflowNodeView,
  type WorkflowStepView,
  type WorkflowView,
} from "../api";
import { fmtBytes, fmtClock, fmtDuration, fmtUsage, stageLabelClass, stageToneClass, stateClass } from "../format";
import { useTaskLive } from "../useTaskLive";

type TaskActions = Record<TaskControlAction, boolean>;

const MENU_ACTIONS = [
  { key: "pause" as const, label: "暂停", run: (id: string) => api.pause(id) },
  { key: "resume" as const, label: "继续", run: (id: string) => api.resume(id) },
  { key: "abort" as const, label: "中止", run: (id: string) => api.abort(id) },
  { key: "cancel" as const, label: "取消", run: (id: string) => api.cancel(id) },
  { key: "retry" as const, label: "重试", run: (id: string) => api.retry(id) },
];

export function TaskPage() {
  const { id = "" } = useParams();
  const { task, repo, kernel, detail, error, reload } = useTaskLive(id);
  const toast = useToast();
  const navigate = useNavigate();
  const ui = useUi();
  const { tasks } = useTaskStore();
  const injectRef = useRef<HTMLInputElement>(null);
  const rejectRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ key: string; ext: string; text: string } | null>(null);
  const [injectText, setInjectText] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [editingPlan, setEditingPlan] = useState(false);
  const [editText, setEditText] = useState("");
  const [planDoc, setPlanDoc] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const loadArtifact = async (key: string, ext: string) => {
    try {
      setPreview({ key, ext, text: await api.artifact(id, key) });
    } catch (e) {
      setPreview({
        key,
        ext,
        text: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

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

  useEffect(() => {
    setPreview(null);
    setPlanDoc(null);
    setPlanError(null);
  }, [id]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menus = document.querySelectorAll<HTMLDetailsElement>("details.task-ops-menu[open]");
      for (const menu of menus) {
        if (!(event.target instanceof Node) || !menu.contains(event.target)) {
          menu.open = false;
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      toast.success(`已${label}`);
    } catch (e) {
      toast.error(`${label}失败`, e);
    }
  };

  // Creation order, not update order: a running task's `updated_at` churns constantly
  // and would make J/K jump to a different neighbour on every tick.
  const siblings = useMemo(
    () => [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((t) => t.id),
    [tasks],
  );

  const goSibling = useCallback(
    (step: number) => {
      const at = siblings.indexOf(id);
      if (at < 0 || siblings.length < 2) return;
      const next = siblings[(at + step + siblings.length) % siblings.length];
      if (next) navigate(`/tasks/${next}`);
    },
    [siblings, id, navigate],
  );

  const keysLive = !ui.anyOverlayOpen && !preview && !!task && !!actions;

  useKeyBindings([
    { combo: "j", run: () => goSibling(1), enabled: keysLive },
    { combo: "k", run: () => goSibling(-1), enabled: keysLive },
    {
      combo: "i",
      run: () => injectRef.current?.focus(),
      enabled: keysLive && !!actions?.inject,
    },
    {
      combo: "r",
      run: () => rejectRef.current?.focus(),
      enabled: keysLive && !!actions?.reject && !!pendingReqId,
    },
    {
      combo: "e",
      run: () => {
        setEditText(planDoc ?? "");
        setEditingPlan(true);
      },
      enabled: keysLive && !!actions?.edit && !!pendingReqId && !editingPlan,
    },
    {
      combo: "a",
      run: () => {
        if (!task || !pendingReqId) return;
        void act("批准", () => api.intervene(task.id, pendingReqId, { action: "approve" }));
      },
      enabled: keysLive && !!actions?.approve && !!pendingReqId,
    },
    {
      combo: "p",
      run: () => {
        if (!task) return;
        if (actions?.pause) void act("暂停", () => api.pause(task.id));
        else if (actions?.resume) void act("继续", () => api.resume(task.id));
      },
      enabled: keysLive && (!!actions?.pause || !!actions?.resume),
    },
  ]);

  if (!task || !actions) {
    return (
      <div className="page-stack">
        {error ? (
          <PageState kind="error" title="无法加载任务">
            {error}
          </PageState>
        ) : (
          <>
            <Skeleton lines={2} />
            <div className="Box">
              <div className="Box-body">
                <Skeleton lines={4} title={false} />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  const workflow = workflowOf(detail);

  return (
    <div className="page-stack">
      <PageHeader
        crumb={{ to: "/", label: "看板" }}
        title={task.title}
        badge={<span className={`State ${stateClass(task.status)}`}>{task.status}</span>}
        actions={
          <details className="task-ops-menu">
            <summary className="btn">
              操作
              <svg className="task-ops-caret" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M4.427 7.427 7.823 10.823a.25.25 0 0 0 .354 0L11.573 7.427A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"
                />
              </svg>
            </summary>
            <div className="task-ops-menu-panel">
              {MENU_ACTIONS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  disabled={!actions[item.key]}
                  onClick={(e) => {
                    const menu = e.currentTarget.closest("details") as HTMLDetailsElement | null;
                    if (menu) menu.open = false;
                    void act(item.label, () => item.run(task.id));
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </details>
        }
      />

      {task.error && <StatusBanner kind="error">{task.error}</StatusBanner>}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className="task-layout">
        <div className="task-main">
          {pendingReqId && (
            <div className="Box task-intervene">
              <div className="Box-header">
                <h2>{pendingIsLimit ? "循环已达上限" : "待审批"}</h2>
              </div>
              <div className="Box-body">
                <div className="plan-panel">
                  <div className="plan-toolbar">
                    <strong>{pendingIsLimit ? "审阅当前结果" : "审阅计划 (planDoc)"}</strong>
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
                        className="plan-editor"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={18}
                      />
                      <div className="action-bar plan-editor-actions">
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={!actions.edit || !editText.trim()}
                          onClick={() =>
                            void act("保存并批准", async () => {
                              await api.intervene(task.id, pendingReqId, {
                                action: "edit",
                                content: editText,
                              });
                              setEditingPlan(false);
                            })
                          }
                        >
                          保存并批准
                        </button>
                        <button className="btn" type="button" onClick={() => setEditingPlan(false)}>
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
                  <p className="muted plan-hint">
                    {kernel?.pendingIntervention?.summary ?? "循环已达最大次数。"} 批准
                    将带着当前结果继续后续步骤，驳回则保持挂起。
                  </p>
                )}
                <div className="action-bar">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!actions.approve}
                    onClick={() =>
                      void act("批准", () =>
                        api.intervene(task.id, pendingReqId, { action: "approve" }),
                      )
                    }
                  >
                    批准
                    <kbd className="kbd">A</kbd>
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
                    <kbd className="kbd">E</kbd>
                  </button>
                  <input
                    ref={rejectRef}
                    placeholder="驳回意见"
                    value={rejectText}
                    onChange={(e) => setRejectText(e.target.value)}
                  />
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={!actions.reject}
                    onClick={() =>
                      void act("驳回", () =>
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
                    驳回
                    <kbd className="kbd">R</kbd>
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="Box">
            <div className="Box-header">
              <h2>需求</h2>
            </div>
            <div className="Box-body">
              {task.requirement.trim() ? (
                <div className="task-req">
                  <Markdown content={task.requirement} />
                </div>
              ) : (
                <p className="muted">无需求文本</p>
              )}
            </div>
          </div>

          <div className="Box">
            <div className="Box-header">
              <h2>流水线</h2>
              {workflow && <span className="Counter">{countWorkflowNodes(workflow)}</span>}
            </div>
            <div className="Box-body">
              {workflow && workflow.steps.length > 0 ? (
                <div className="workflow">
                  {workflow.steps.map((step, i) => (
                    <WorkflowStep
                      key={stepKey(step, i)}
                      step={step}
                      taskId={id}
                      currentNode={task.current_node}
                    />
                  ))}
                </div>
              ) : (
                <PageState kind="empty" title="无法还原流水线定义" />
              )}
            </div>
          </div>

          <div className="Box">
            <div className="Box-header">
              <h2>交付件</h2>
            </div>
            <div className="Box-body">
              {detail && detail.artifacts.length > 0 ? (
                <div className="table-scroll">
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
                              onClick={() => void loadArtifact(a.key, a.ext)}
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
                </div>
              ) : (
                <PageState kind="empty" title="暂无交付件" />
              )}
            </div>
          </div>

          <div className="Box">
            <div className="Box-header">
              <h2>提交与介入</h2>
            </div>
            <div className="Box-body">
              <h3 className="subsection-title">提交</h3>
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
              <h3 className="subsection-title subsection-title--later">介入记录</h3>
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

        <TaskAside
          task={task}
          repo={repo}
          detail={detail}
          actions={actions}
          injectText={injectText}
          onInjectText={setInjectText}
          onAct={act}
          injectRef={injectRef}
        />
      </div>

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div
            className="modal-panel modal-panel--wide Box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="artifact-preview-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="Box-header">
              <h2 id="artifact-preview-title">
                {preview.key}.{preview.ext}
              </h2>
              <button className="btn" type="button" onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
            <div className="Box-body">
              <ArtifactPreview
                artifactKey={preview.key}
                ext={preview.ext}
                text={preview.text}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskAside({
  task,
  repo,
  detail,
  actions,
  injectText,
  onInjectText,
  onAct,
  injectRef,
}: {
  task: Task;
  repo: Repo | null;
  detail: TaskDetail | null;
  actions: TaskActions;
  injectText: string;
  onInjectText: (value: string) => void;
  onAct: (label: string, fn: () => Promise<unknown>) => void;
  injectRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="task-aside">
      <aside className="task-aside-props" aria-label="任务属性">
        <h2 className="task-aside-title">详情</h2>
        <dl className="task-props">
          {repo && (
            <PropRow label="仓库">
              <span title={repo.full_name}>{repo.full_name}</span>
            </PropRow>
          )}
          {task.issue_number != null && repo && (
            <PropRow label="Issue">
              <a
                href={`https://github.com/${repo.full_name}/issues/${task.issue_number}`}
                target="_blank"
                rel="noreferrer"
              >
                #{task.issue_number}
              </a>
            </PropRow>
          )}
          {task.pr_number != null && repo && (
            <PropRow label="PR">
              <a
                href={`https://github.com/${repo.full_name}/pull/${task.pr_number}`}
                target="_blank"
                rel="noreferrer"
              >
                #{task.pr_number}
              </a>
            </PropRow>
          )}
          {task.branch && (
            <PropRow label="分支">
              <span className="Label" title={task.branch}>
                {task.branch}
              </span>
            </PropRow>
          )}
          {task.current_node && (
            <PropRow label="当前节点">
              <span className="Label Label--accent">{task.current_node}</span>
            </PropRow>
          )}
          {asideDetailRows(detail).map(([label, value]) => (
            <PropRow key={label} label={label}>
              {value}
            </PropRow>
          ))}
        </dl>
        {detail?.error && <p className="error">{detail.error}</p>}
      </aside>

      <section aria-label="注入">
        <h2 className="task-aside-title">注入</h2>
        <div className="task-inject">
          <input
            ref={injectRef}
            placeholder={actions.inject ? "例如：不要动 legacy/" : "当前无法注入"}
            value={injectText}
            disabled={!actions.inject}
            onChange={(e) => onInjectText(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={!actions.inject || !injectText.trim()}
            onClick={() =>
              void onAct("注入", async () => {
                await api.inject(task.id, injectText);
                onInjectText("");
              })
            }
          >
            注入
          </button>
        </div>
        <p className="muted task-inject-hint">{injectHint(task.status, actions.inject)}</p>
      </section>
    </div>
  );
}

function injectHint(status: Task["status"], canInject: boolean): string {
  if (canInject) return "下一节点生效，不暂停任务。";
  switch (status) {
    case "done":
    case "merged":
      return "任务已结束，无法再注入指令。";
    case "failed":
      return "任务已失败，无法注入。可重试后再注入。";
    case "cancelled":
      return "任务已取消，无法注入。可重试后再注入。";
    case "paused":
      return "任务已暂停，恢复后再注入。";
    case "waiting_human":
      return "请先处理上方审批。";
    case "delivering":
      return "正在交付，无法注入。";
    case "queued":
    case "preparing":
      return "任务尚未开始运行，暂不能注入。";
    default:
      return "当前状态无法注入指令。";
  }
}

function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-prop">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function asideDetailRows(detail: TaskDetail | null): Array<[string, ReactNode]> {
  if (!detail) return [];
  return [
    ["流水线", `${detail.pipeline.name} (${detail.pipeline.hash.slice(0, 12)})`],
    ["Worktree", detail.git.worktreePath || "—"],
    [
      "Commit",
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
    ["Token", fmtUsage(detail.usage)],
    ["事件", `${detail.eventCount} 条 (seq ≤ ${detail.lastSeq})`],
  ];
}

function workflowOf(detail: TaskDetail | null): WorkflowView | null {
  if (!detail) return null;
  if (detail.workflow?.steps.length) return detail.workflow;
  return buildWorkflowView(detail.pipeline.name, detail.stages);
}

function stepKey(step: WorkflowStepView, index: number): string {
  return step.kind === "loop" ? `loop:${step.loop.loopId}` : `node:${step.node.nodeId}:${index}`;
}

function WorkflowStep({
  step,
  taskId,
  currentNode,
}: {
  step: WorkflowStepView;
  taskId: string;
  currentNode: string | null;
}) {
  if (step.kind === "loop") {
    const { loop } = step;
    return (
      <div className="workflow-loop">
        <div className="workflow-loop-head">
          <strong>{loop.loopId}</strong>
          <span className="muted">
            {loop.iteration != null ? `${loop.iteration}/${loop.maxIterations}` : `最多 ${loop.maxIterations} 次`}
            {" · "}
            until {loop.until}
          </span>
        </div>
        <div className="workflow-loop-body">
          {loop.body.map((node) => (
            <WorkflowNode key={node.nodeId} node={node} taskId={taskId} current={node.nodeId === currentNode} />
          ))}
        </div>
      </div>
    );
  }
  return <WorkflowNode node={step.node} taskId={taskId} current={step.node.nodeId === currentNode} />;
}

function WorkflowNode({
  node,
  taskId,
  current,
}: {
  node: WorkflowNodeView;
  taskId: string;
  current: boolean;
}) {
  return (
    <Link
      className={`workflow-node ${stageToneClass(node.status)}${current ? " workflow-node--current" : ""}`}
      to={`/tasks/${taskId}/nodes/${encodeURIComponent(node.nodeId)}`}
    >
      <strong>{node.nodeId}</strong>
      <span className="Label">{node.primitive}</span>
      {node.engine && <span className="muted">{node.engine}</span>}
      {node.runCount > 1 && <span className="Label">第 {node.runCount} 次</span>}
      <span className="grow-spacer" />
      <span className="muted">{fmtDuration(node.durationMs)}</span>
      <span className={`Label ${stageLabelClass(node.status)}`}>{node.status}</span>
    </Link>
  );
}
