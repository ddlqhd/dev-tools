import { useEffect, useState } from "react";
import { Box, Spacer, Text } from "ink";
import type { UiState } from "./reducer.js";
import { loopLabel } from "./reducer.js";
import {
  colors,
  formatCost,
  formatDuration,
  formatTokens,
  shortId,
  statusColor,
} from "./theme.js";

export interface StatusBarProps {
  state: UiState;
  canInject: boolean;
}

export function StatusBar({ state, canInject }: StatusBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (state.finishedAt || !state.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.finishedAt, state.startedAt]);

  const elapsed = state.startedAt
    ? formatDuration((state.finishedAt ?? now) - state.startedAt)
    : "0.0s";
  const loop = loopLabel(state);
  const tokenTotal = state.counters.inputTokens + state.counters.outputTokens;
  const cost = formatCost(state.counters.costUsd);
  const finished =
    state.status === "completed" || state.status === "failed" || state.status === "aborted";
  const hints = finished
    ? ""
    : state.pending
      ? "↑↓ select · enter confirm"
      : canInject
        ? "i inject · q detach · ctrl+c detach"
        : "ctrl+c abort";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Box flexShrink={1}>
          <Text color={statusColor(state.status)} bold>
            {state.status}
          </Text>
          <Text dimColor> · {shortId(state.meta.taskId)}</Text>
          {state.activeNode ? <Text> · {state.activeNode.nodeId}</Text> : null}
          {!state.activeNode && state.snapshotNode ? <Text> · {state.snapshotNode}</Text> : null}
          {loop ? <Text dimColor> · {loop}</Text> : null}
        </Box>
        <Spacer />
        <Box flexShrink={0}>
          <Text dimColor>{elapsed}</Text>
          <Text color={colors.accent}> · ⚙ {state.counters.tools}</Text>
          <Text color={colors.info}> · ✎ {state.counters.files}</Text>
          {tokenTotal > 0 ? <Text dimColor> · {formatTokens(tokenTotal)} tok</Text> : null}
          {cost ? <Text dimColor> · {cost}</Text> : null}
        </Box>
      </Box>
      {hints ? <Text dimColor>{hints}</Text> : null}
    </Box>
  );
}
