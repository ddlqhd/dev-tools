import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { UiState } from "./reducer.js";
import { colors, oneLine } from "./theme.js";

export interface LiveRegionProps {
  state: UiState;
}

export function LiveRegion({ state }: LiveRegionProps) {
  if (state.status === "completed" || state.status === "failed" || state.status === "aborted") {
    return null;
  }

  const node = state.activeNode;
  const label =
    state.status === "idle"
      ? state.meta.mode === "watch"
        ? "connecting to task"
        : "preparing task"
      : node
        ? `${node.nodeId} · ${node.primitive}`
        : state.snapshotNode
          ? state.snapshotNode
        : state.status === "suspended"
          ? "waiting for input"
          : "running pipeline";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {state.status === "running" || state.status === "idle" ? (
          <Text color={colors.accent}>
            <Spinner type="dots" />{" "}
          </Text>
        ) : (
          <Text color={colors.warn}>⏸ </Text>
        )}
        <Text bold>{label}</Text>
        {node?.engine ? (
          <Text dimColor>
            {" "}
            · {node.engine}
            {node.model ? `/${node.model}` : ""}
          </Text>
        ) : null}
      </Box>
      {state.stream?.partial ? (
        <Box marginLeft={2}>
          <Text
            dimColor={state.stream.kind === "thinking"}
            italic={state.stream.kind === "thinking"}
            wrap="truncate-end"
          >
            {state.stream.kind === "thinking" ? "thinking · " : "reply · "}
            {oneLine(state.stream.partial, 240)}
          </Text>
        </Box>
      ) : node?.lastTool || node?.lastFile ? (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-middle">
            {node.lastTool ? `tool · ${node.lastTool}` : `file · ${node.lastFile}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
