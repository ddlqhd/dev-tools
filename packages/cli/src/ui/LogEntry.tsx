import { Box, Text } from "ink";
import type { LogEntry as LogEntryModel, UiMeta } from "./reducer.js";
import {
  colors,
  formatCost,
  formatDuration,
  formatTokens,
  icons,
  logLevelColor,
  oneLine,
  primitiveColor,
  severityColor,
  shortId,
  statusColor,
} from "./theme.js";

export interface LogEntryProps {
  entry: LogEntryModel;
}

export function LogEntry({ entry }: LogEntryProps) {
  switch (entry.kind) {
    case "header":
      return <Header meta={entry.meta} />;
    case "nodeStart": {
      const engine = [entry.engine, entry.model].filter(Boolean).join("/");
      return (
        <Box marginTop={1}>
          <Text color={primitiveColor(entry.primitive)} bold>
            {icons.nodeStart} {entry.nodeId}
          </Text>
          <Text dimColor> {entry.primitive}</Text>
          {engine ? <Text dimColor> · {engine}</Text> : null}
          {entry.loopLabel ? <Text color={colors.muted}> · {entry.loopLabel}</Text> : null}
        </Box>
      );
    }
    case "nodeDone": {
      const stats = [
        entry.durationMs === undefined ? undefined : formatDuration(entry.durationMs),
        entry.tools > 0 ? `${entry.tools} tools` : undefined,
        entry.files > 0 ? `${entry.files} files` : undefined,
      ].filter(Boolean);
      return (
        <Box>
          <Text color={colors.ok}>{icons.nodeDone}</Text>
          <Text bold> {entry.nodeId}</Text>
          {stats.length > 0 ? <Text dimColor> · {stats.join(" · ")}</Text> : null}
          {entry.outcome ? <Text dimColor> · {oneLine(entry.outcome, 100)}</Text> : null}
        </Box>
      );
    }
    case "nodeRetry":
      return (
        <Box marginLeft={2}>
          <Text color={colors.warn}>{icons.retry}</Text>
          <Text> {entry.nodeId}</Text>
          <Text dimColor> attempt {entry.attempt}</Text>
          <Text color={colors.warn}> · {oneLine(entry.error)}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box marginLeft={2}>
          <Text color={colors.accent}>{icons.tool}</Text>
          <Text bold> {entry.tool}</Text>
          {entry.summary ? <Text dimColor> {oneLine(entry.summary)}</Text> : null}
        </Box>
      );
    case "file":
      return (
        <Box marginLeft={2}>
          <Text color={colors.info}>{icons.file}</Text>
          <Text> {entry.path}</Text>
          <Text dimColor> ({entry.op})</Text>
        </Box>
      );
    case "text":
      return <AssistantLine text={entry.text} />;
    case "thinking":
      return (
        <Box marginLeft={2}>
          <Text dimColor italic wrap="wrap">
            │ {entry.text || " "}
          </Text>
        </Box>
      );
    case "commit":
      return (
        <Box marginLeft={2}>
          <Text color={colors.ok}>{icons.commit}</Text>
          <Text> commit </Text>
          <Text color={colors.accent}>{shortId(entry.sha)}</Text>
          {entry.message ? <Text dimColor> · {oneLine(entry.message)}</Text> : null}
        </Box>
      );
    case "review":
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={entry.passed ? colors.ok : colors.warn}>
            {icons.review} review {entry.passed ? "passed" : `${entry.comments.length} issue(s)`}
          </Text>
          {entry.comments.slice(0, 6).map((comment) => (
            <Box key={comment.id} marginLeft={2}>
              <Text color={severityColor(comment.severity)}>{comment.severity}</Text>
              {comment.file ? (
                <Text dimColor>
                  {" "}
                  {comment.file}
                  {comment.line ? `:${comment.line}` : ""}
                </Text>
              ) : null}
              <Text> · {oneLine(comment.comment, 130)}</Text>
            </Box>
          ))}
          {entry.comments.length > 6 ? (
            <Text dimColor> … and {entry.comments.length - 6} more</Text>
          ) : null}
        </Box>
      );
    case "artifact":
      return (
        <Box marginLeft={2}>
          <Text color={colors.info}>{icons.artifact}</Text>
          <Text> {entry.key}</Text>
          <Text dimColor> → {entry.path}</Text>
        </Box>
      );
    case "usage": {
      const cost = entry.costUsd ? formatCost(entry.costUsd) : "";
      return (
        <Box marginLeft={2}>
          <Text dimColor>
            {icons.usage} tokens {formatTokens(entry.inputTokens)} in /{" "}
            {formatTokens(entry.outputTokens)} out{cost ? ` · ${cost}` : ""}
          </Text>
        </Box>
      );
    }
    case "loop":
      return (
        <Box>
          <Text color={colors.accent}>{icons.loop}</Text>
          <Text> {entry.loopId}</Text>
          <Text dimColor>
            {" "}
            iteration {entry.iteration}/{entry.maxIterations}
          </Text>
        </Box>
      );
    case "intervention":
      return (
        <Box marginTop={1}>
          <Text color={colors.warn} bold>
            {icons.gate} approval required
          </Text>
          <Text> · {entry.request.nodeId}</Text>
          <Text dimColor> · {entry.request.kind}</Text>
        </Box>
      );
    case "resolved":
      return (
        <Box>
          <Text color={colors.ok}>{icons.resolved}</Text>
          <Text> intervention {entry.action}</Text>
          {entry.detail ? <Text dimColor> · {oneLine(entry.detail)}</Text> : null}
        </Box>
      );
    case "inject":
      return (
        <Box>
          <Text color={colors.accent}>{icons.inject}</Text>
          <Text> instruction </Text>
          <Text dimColor>{oneLine(entry.text)}</Text>
        </Box>
      );
    case "status":
      return (
        <Box>
          <Text color={statusColor(entry.status)} bold>
            {statusIcon(entry.status)} {entry.status}
          </Text>
          {entry.detail ? <Text dimColor> · {oneLine(entry.detail)}</Text> : null}
        </Box>
      );
    case "log":
      return (
        <Box marginLeft={2}>
          <Text color={logLevelColor(entry.level)}>{logIcon(entry.level)}</Text>
          <Text dimColor={entry.level === "debug"}> {entry.message}</Text>
        </Box>
      );
    case "notice":
      return (
        <Box>
          <Text color={logLevelColor(entry.level)}>
            {entry.level === "error" ? icons.error : entry.level === "warn" ? icons.warn : icons.info}
          </Text>
          <Text color={logLevelColor(entry.level)}> {entry.text}</Text>
        </Box>
      );
  }
}

function Header({ meta }: { meta: UiMeta }) {
  const details = [
    meta.pipeline ? `pipeline ${meta.pipeline}` : undefined,
    meta.taskId ? `task ${shortId(meta.taskId, 12)}` : undefined,
    meta.endpoint ? `via ${meta.endpoint}` : undefined,
  ].filter(Boolean);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      borderDimColor
      paddingX={1}
    >
      <Box>
        <Text color={colors.accent} bold>
          codeloop
        </Text>
        <Text dimColor> {meta.mode}</Text>
        {details.length > 0 ? <Text dimColor> · {details.join(" · ")}</Text> : null}
      </Box>
      {meta.requirement ? (
        <Text wrap="wrap">
          <Text dimColor>request </Text>
          {oneLine(meta.requirement, 240)}
        </Text>
      ) : null}
      {meta.repoPath ? (
        <Text dimColor wrap="truncate-middle">
          repo {meta.repoPath}
        </Text>
      ) : null}
      {meta.branch ? (
        <Text dimColor wrap="truncate-middle">
          branch {meta.branch}
        </Text>
      ) : null}
    </Box>
  );
}

function AssistantLine({ text }: { text: string }) {
  const heading = /^(#{1,4})\s+(.+)$/.exec(text);
  if (heading) {
    return (
      <Box marginLeft={2} marginTop={heading[1]?.length === 1 ? 1 : 0}>
        <Text color={colors.accent} bold>
          {heading[2]}
        </Text>
      </Box>
    );
  }

  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(text);
  if (bullet) {
    return (
      <Box marginLeft={Math.min(6, 2 + Math.floor((bullet[1]?.length ?? 0) / 2) * 2)}>
        <Text color={colors.accent}>•</Text>
        <Text wrap="wrap"> {bullet[2]}</Text>
      </Box>
    );
  }

  if (/^\s*```/.test(text)) {
    return (
      <Box marginLeft={2}>
        <Text color={colors.muted}>┄ {text.trim()}</Text>
      </Box>
    );
  }

  if (!text.trim()) return <Text> </Text>;
  return (
    <Box marginLeft={2}>
      <Text wrap="wrap">{text}</Text>
    </Box>
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case "completed":
      return icons.nodeDone;
    case "failed":
    case "aborted":
      return icons.error;
    case "suspended":
      return icons.gate;
    default:
      return icons.info;
  }
}

function logIcon(level: string): string {
  if (level === "error") return icons.error;
  if (level === "warn") return icons.warn;
  return icons.info;
}
