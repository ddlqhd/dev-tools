import { Link, useParams } from "react-router-dom";
import {
  eventsInStageRange,
  foldNodeEventStream,
  parseStoredKernelEvents,
  type NodeStreamItem,
} from "@devtools/shared";
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

  if (!task || !detail) {
    return <p className="muted">{error ?? "加载中…"}</p>;
  }

  const stages = detail.stages.filter((s) => s.nodeId === nodeId);
  const known =
    stages.length > 0 ||
    (detail.workflow?.steps ?? []).some((step) =>
      step.kind === "loop" ? step.loop.body.some((n) => n.nodeId === nodeId) : step.node.nodeId === nodeId,
    );

  return (
    <>
      <p className="muted">
        <Link to={`/tasks/${id}`}>← {task.title}</Link>
      </p>
      <h1 className="issue-title">
        {nodeId}
        <span className={`State ${stateClass(task.status)}`}>{task.status}</span>
      </h1>
      <div className="issue-meta">
        <span className="Label">{latestPrimitive(stages, nodeId, detail)}</span>
        {stages[stages.length - 1]?.engine && (
          <span className="muted">{stages[stages.length - 1]!.engine}</span>
        )}
        {task.current_node === nodeId && <span className="Label Label--accent">当前节点</span>}
        <span className="muted">{stages.length ? `已执行 ${stages.length} 次` : "尚未执行"}</span>
      </div>
      {error && <p className="error">{error}</p>}

      {!known ? (
        <div className="Box">
          <div className="Box-body">
            <p className="muted">节点 {nodeId} 不在这条流水线中。</p>
            <p>
              <Link to={`/tasks/${id}`}>返回任务</Link>
            </p>
          </div>
        </div>
      ) : stages.length === 0 ? (
        <div className="Box">
          <div className="Box-body">
            <p className="muted">该节点尚未执行，暂无事件。</p>
          </div>
        </div>
      ) : (
        stages.map((stage) => (
          <NodeRun
            key={stage.index}
            stage={stage}
            events={events}
            latest={stage.index === detail.stages[detail.stages.length - 1]?.index}
          />
        ))
      )}
    </>
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
}: {
  stage: StageExecution;
  events: TaskEvent[];
  latest: boolean;
}) {
  const slice = eventsInStageRange(events, stage, latest);
  const items = foldNodeEventStream(parseStoredKernelEvents(slice));
  return (
    <div className={`Box stage stage--${stage.status}`}>
      <div className="Box-header">
        <h2>
          第 {stage.nodeRun} 次
          {stage.loopLabel ? ` · ${stage.loopLabel}` : ""}
        </h2>
        <span className="muted">{fmtDuration(stage.durationMs)}</span>
        <span className={`Label ${stageLabelClass(stage.status)}`}>{stage.status}</span>
      </div>
      <div className="Box-body">
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
              <span key={a.key} className="Label" style={{ marginRight: 6 }}>
                {a.key}
                {a.ext ? `.${a.ext}` : ""}
              </span>
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
        <NodeStream items={items} />
      </div>
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
