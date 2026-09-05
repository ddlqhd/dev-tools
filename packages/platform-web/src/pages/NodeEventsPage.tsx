import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  eventsInStageRange,
  foldNodeEventStream,
  parseStoredKernelEvents,
  type NodeStreamItem,
} from "@devtools/shared";
import { PageHeader } from "../components/PageHeader";
import { PageState, StatusBanner } from "../components/PageState";
import type { StageExecution, TaskDetail, TaskEvent } from "../api";
import { fmtDuration, outcomeSummary, stageLabelClass, stateClass } from "../format";
import { useTaskLive } from "../useTaskLive";

function decodeNodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function NodeEventsPage() {
  const { id = "", nodeId: rawNodeId = "" } = useParams();
  const nodeId = decodeNodeId(rawNodeId);
  const { task, detail, events, error } = useTaskLive(id);

  const stagesForNode = detail?.stages.filter((s) => s.nodeId === nodeId) ?? [];
  const latestStageIndex = stagesForNode.at(-1)?.index ?? null;
  const [expanded, setExpanded] = useState<Set<number> | null>(null);
  const effectiveExpanded =
    expanded ?? (latestStageIndex != null ? new Set([latestStageIndex]) : new Set());

  useEffect(() => {
    setExpanded(null);
  }, [nodeId, latestStageIndex]);

  function toggle(stageIndex: number) {
    const next = new Set(effectiveExpanded);
    if (next.has(stageIndex)) next.delete(stageIndex);
    else next.add(stageIndex);
    setExpanded(next);
  }

  if (!task || !detail) {
    return (
      <div className="page-stack">
        {error ? (
          <PageState kind="error" title="无法加载节点过程">
            {error}
          </PageState>
        ) : (
          <PageState kind="loading" title="加载中…" />
        )}
      </div>
    );
  }

  const stages = stagesForNode;
  const known =
    stages.length > 0 ||
    (detail.workflow?.steps ?? []).some((step) =>
      step.kind === "loop" ? step.loop.body.some((n) => n.nodeId === nodeId) : step.node.nodeId === nodeId,
    );

  return (
    <div className="page-stack">
      <PageHeader
        sticky
        crumb={{ to: `/tasks/${id}`, label: task.title }}
        title={nodeId}
        badge={<span className={`State ${stateClass(task.status)}`}>{task.status}</span>}
        meta={
          <>
            <span className="Label">{latestPrimitive(stages, nodeId, detail)}</span>
            {stages[stages.length - 1]?.engine && (
              <span className="muted">{stages[stages.length - 1]!.engine}</span>
            )}
            {task.current_node === nodeId && <span className="Label Label--accent">当前节点</span>}
            <span className="muted">{stages.length ? `已执行 ${stages.length} 次` : "尚未执行"}</span>
          </>
        }
      />
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {!known ? (
        <PageState kind="empty" title={`节点 ${nodeId} 不在这条流水线中`}>
          <Link to={`/tasks/${id}`}>返回任务</Link>
        </PageState>
      ) : stages.length === 0 ? (
        <PageState kind="empty" title="该节点尚未执行">
          暂无事件。
        </PageState>
      ) : (
        stages.map((stage) => (
          <NodeRun
            key={stage.index}
            stage={stage}
            events={events}
            latest={stage.index === latestStageIndex}
            expanded={effectiveExpanded.has(stage.index)}
            onToggle={() => toggle(stage.index)}
          />
        ))
      )}
    </div>
  );
}

function latestPrimitive(stages: StageExecution[], nodeId: string, detail: TaskDetail): string {
  if (stages.length) return stages[stages.length - 1]!.primitive;
  for (const step of detail.workflow?.steps ?? []) {
    const nodes = step.kind === "loop" ? step.loop.body : [step.node];
    const hit = nodes.find((n) => n.nodeId === nodeId);
    if (hit) return hit.primitive;
  }
  return "node";
}

function NodeRun({
  stage,
  events,
  latest,
  expanded,
  onToggle,
}: {
  stage: StageExecution;
  events: TaskEvent[];
  latest: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const items = expanded
    ? foldNodeEventStream(parseStoredKernelEvents(eventsInStageRange(events, stage, latest)))
    : [];
  const loopLabel = stage.loopLabel ? ` · ${stage.loopLabel}` : "";
  const bodyId = `stage-body-${stage.index}`;
  return (
    <div className={`Box stage stage--${stage.status}`}>
      <button
        type="button"
        className="stage-head"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="stage-title">
          第 {stage.nodeRun} 次{loopLabel}
        </span>
        {latest && <span className="Label Label--accent">最新</span>}
        <span className="muted">{fmtDuration(stage.durationMs)}</span>
        <span className={`Label ${stageLabelClass(stage.status)}`}>{stage.status}</span>
      </button>
      {expanded && (
        <div className="stage-body" id={bodyId}>
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
              <span className="label-pack">
                {stage.artifacts.map((a) => (
                  <span key={a.key} className="Label">
                    {a.key}
                    {a.ext ? `.${a.ext}` : ""}
                  </span>
                ))}
              </span>
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
          <NodeStream items={items} />
        </div>
      )}
    </div>
  );
}

function NodeStream({ items }: { items: NodeStreamItem[] }) {
  if (!items.length) return <p className="muted">该次执行没有可展示的事件</p>;
  return (
    <div className="node-stream">
      {items.map((item, i) => (
        <StreamItem key={`${item.ts}-${i}`} item={item} />
      ))}
    </div>
  );
}

function StreamItem({ item }: { item: NodeStreamItem }) {
  if (item.kind === "text" || item.kind === "thinking") {
    return (
      <pre className={`stream-block stream-block--${item.kind}`}>
        <span className="stream-kicker">{item.kind === "thinking" ? "thinking" : "输出"}</span>
        {item.text}
      </pre>
    );
  }
  if (item.kind === "tool") {
    return (
      <p className="stream-line">
        <span className="Label">工具</span> {item.tool}{" "}
        <span className="muted">{item.summary}</span>
      </p>
    );
  }
  if (item.kind === "file") {
    return (
      <p className="stream-line">
        <span className="Label">文件</span> {item.op} {item.path}
      </p>
    );
  }
  return (
    <p className={`stream-line${item.tone ? ` stream-line--${item.tone}` : ""}`}>
      <span className="Label">{item.label}</span> {item.detail}
    </p>
  );
}
