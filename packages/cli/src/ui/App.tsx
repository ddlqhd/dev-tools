import { useRef, useState, useSyncExternalStore } from "react";
import { Box, Static, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { InterventionDecision, InterventionRequest } from "@devtools/shared";
import { InterventionPanel } from "./InterventionPanel.js";
import { LiveRegion } from "./LiveRegion.js";
import { LogEntry } from "./LogEntry.js";
import { StatusBar } from "./StatusBar.js";
import type { UiStore } from "./store.js";
import { colors } from "./theme.js";

export interface AppProps {
  store: UiStore;
  onDecision?: (
    request: InterventionRequest,
    decision: InterventionDecision,
  ) => void | Promise<void>;
  onInject?: (text: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

export function App({ store, onDecision, onInject, onCancel }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [injecting, setInjecting] = useState(false);
  const cancelStarted = useRef(false);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      if (!cancelStarted.current) {
        cancelStarted.current = true;
        void onCancel?.();
      }
      return;
    }
    if (state.pending || injecting) return;
    if (onInject && input.toLowerCase() === "i") {
      setInjecting(true);
      return;
    }
    if (state.meta.mode === "watch" && input.toLowerCase() === "q") {
      if (!cancelStarted.current) {
        cancelStarted.current = true;
        void onCancel?.();
      }
    }
  });

  const submitDecision = (request: InterventionRequest, decision: InterventionDecision) => {
    if (!onDecision) return;
    store.dispatch({ type: "submitStart", requestId: request.requestId });
    store.flush();
    void Promise.resolve()
      .then(() => onDecision(request, decision))
      .then(
        () => {
          store.dispatch({ type: "submitDone", requestId: request.requestId });
          store.flush();
        },
        (error: unknown) => {
          store.dispatch({
            type: "submitError",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : String(error),
          });
          store.flush();
        },
      );
  };

  return (
    <Box flexDirection="column">
      <Static items={state.entries}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column">
            <LogEntry entry={entry} />
          </Box>
        )}
      </Static>

      {state.pending && onDecision ? (
        <InterventionPanel
          request={state.pending}
          busy={state.pendingBusy}
          error={state.pendingError}
          onSubmit={(decision) => submitDecision(state.pending!, decision)}
        />
      ) : injecting && onInject ? (
        <InjectPanel
          onCancel={() => setInjecting(false)}
          onSubmit={async (text) => {
            await onInject(text);
            setInjecting(false);
          }}
        />
      ) : (
        <LiveRegion state={state} />
      )}

      <StatusBar state={state} canInject={Boolean(onInject)} />
    </Box>
  );
}

interface InjectPanelProps {
  onCancel: () => void;
  onSubmit: (text: string) => Promise<void>;
}

function InjectPanel({ onCancel, onSubmit }: InjectPanelProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useInput(
    (_input, key) => {
      if (key.escape && !busy) onCancel();
    },
    { isActive: !busy },
  );

  const submit = (text: string) => {
    const cleaned = text.trim();
    if (!cleaned || busy) return;
    setBusy(true);
    setError(undefined);
    void onSubmit(cleaned).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={error ? colors.err : colors.accent}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text color={colors.accent} bold>
          Inject instruction
        </Text>
        <Text dimColor> · delivered before the next node · esc to cancel</Text>
      </Box>
      <Box>
        <Text color={colors.accent}>› </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          focus={!busy}
          placeholder="Add guidance for the running task"
        />
      </Box>
      {busy ? <Text color={colors.accent}>sending…</Text> : null}
      {error ? <Text color={colors.err}>Could not inject: {error}</Text> : null}
    </Box>
  );
}
