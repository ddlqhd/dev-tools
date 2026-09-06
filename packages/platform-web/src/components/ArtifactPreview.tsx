import { useEffect, useState, type ReactNode } from "react";
import {
  summarizeArtifactJson,
  type ArtifactJsonSummary,
  type ReviewComment,
} from "@devtools/shared";
import { prettyJson } from "../format";
import { Markdown } from "./Markdown";

type Props = {
  artifactKey: string;
  ext: string;
  text: string;
};

function severityClass(severity: ReviewComment["severity"]): string {
  if (severity === "blocker" || severity === "major") return "Label Label--danger";
  if (severity === "minor") return "Label Label--attention";
  return "Label";
}

function PassedLabel({ passed }: { passed: boolean }) {
  return (
    <span className={passed ? "Label Label--success" : "Label Label--danger"}>
      {passed ? "通过" : "未通过"}
    </span>
  );
}

function JsonSummaryBody({ summary }: { summary: ArtifactJsonSummary }) {
  switch (summary.kind) {
    case "review": {
      const { result } = summary;
      return (
        <>
          <p>
            <PassedLabel passed={result.passed} />
            {result.summary ? ` ${result.summary}` : null}
          </p>
          {result.comments.length > 0 && (
            <ul>
              {result.comments.map((c) => (
                <li key={c.id}>
                  <span className={severityClass(c.severity)}>{c.severity}</span>
                  {c.file != null && (
                    <span className="muted">
                      {" "}
                      {c.file}
                      {c.line != null ? `:${c.line}` : ""}
                    </span>
                  )}{" "}
                  {c.comment}
                  {c.suggestion ? <div className="muted">{c.suggestion}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case "verify": {
      const { result } = summary;
      return (
        <>
          <p>
            <PassedLabel passed={result.passed} /> {result.summary}
          </p>
          {result.checksRun.length > 0 && (
            <p className="muted">已跑检查：{result.checksRun.join(", ")}</p>
          )}
          {result.failures.length > 0 && (
            <ul>
              {result.failures.map((f, i) => (
                <li key={`${f.check}-${i}`}>
                  <strong>{f.check}</strong>
                  {f.command ? <span className="muted"> {f.command}</span> : null}
                  <div>{f.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case "generic":
      return (
        <dl className="artifact-summary-dl">
          {summary.entries.map((entry) => (
            <div key={entry.key}>
              <dt>{entry.key}</dt>
              <dd>{entry.display}</dd>
            </div>
          ))}
        </dl>
      );
    case "invalid":
      return <p className="error">{summary.message}</p>;
  }
}

export function ArtifactPreview({ artifactKey, ext, text }: Props) {
  const kind = ext.toLowerCase();
  const canToggle = kind === "md" || kind === "markdown" || kind === "json";
  const [mode, setMode] = useState<"rich" | "raw">("rich");

  useEffect(() => {
    setMode("rich");
  }, [artifactKey, text]);

  const richLabel = kind === "json" ? "摘要" : "预览";

  let body: ReactNode;
  if (canToggle && mode === "raw") {
    body = <pre className="artifact">{kind === "json" ? prettyJson(text) : text}</pre>;
  } else if (kind === "md" || kind === "markdown") {
    body = (
      <div className="artifact-preview">
        <Markdown content={text} />
      </div>
    );
  } else if (kind === "json") {
    body = (
      <div className="artifact-summary artifact-preview">
        <JsonSummaryBody summary={summarizeArtifactJson(text)} />
      </div>
    );
  } else {
    body = <pre className="artifact">{text}</pre>;
  }

  return (
    <div>
      <div className="artifact-preview-toolbar">
        <p className="muted artifact-preview-kicker">
          {artifactKey}.{ext}
        </p>
        {canToggle && (
          <div className="view-toggle" role="group" aria-label="预览模式">
            <button
              type="button"
              className={mode === "rich" ? "active" : ""}
              aria-pressed={mode === "rich"}
              onClick={() => setMode("rich")}
            >
              {richLabel}
            </button>
            <button
              type="button"
              className={mode === "raw" ? "active" : ""}
              aria-pressed={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              原文
            </button>
          </div>
        )}
      </div>
      {body}
    </div>
  );
}
