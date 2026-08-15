import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { InterventionDecision, InterventionRequest } from "@devtools/shared";
import { colors, oneLine, shortId } from "./theme.js";

export interface InterventionPanelProps {
  request: InterventionRequest;
  busy: boolean;
  error?: string;
  onSubmit: (decision: InterventionDecision) => void;
}

type Choice = "approve" | "reject";
type EntryMode = "choice" | "reject";

const choices: Array<{ value: Choice; key: string; label: string }> = [
  { value: "approve", key: "a", label: "Approve" },
  { value: "reject", key: "r", label: "Reject" },
];

export function InterventionPanel({
  request,
  busy,
  error,
  onSubmit,
}: InterventionPanelProps) {
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<EntryMode>("choice");
  const [value, setValue] = useState("");

  useEffect(() => {
    setSelected(0);
    setMode("choice");
    setValue("");
  }, [request.requestId]);

  const choose = (choice: Choice) => {
    if (choice === "approve") {
      onSubmit({ action: "approve" });
      return;
    }
    setMode(choice);
    setValue("");
  };

  useInput(
    (input, key) => {
      if (busy || mode !== "choice") return;
      if (key.leftArrow || key.upArrow) {
        setSelected((current) => (current + choices.length - 1) % choices.length);
        return;
      }
      if (key.rightArrow || key.downArrow || key.tab) {
        setSelected((current) => (current + 1) % choices.length);
        return;
      }
      if (key.return) {
        choose(choices[selected]?.value ?? "approve");
        return;
      }
      const shortcut = choices.find((item) => item.key === input.toLowerCase());
      if (shortcut) choose(shortcut.value);
    },
    { isActive: !busy && mode === "choice" },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setMode("choice");
        setValue("");
      }
    },
    { isActive: !busy && mode !== "choice" },
  );

  const submitText = (text: string) => {
    const cleaned = text.trim();
    onSubmit({
      action: "reject",
      comments: [
        {
          id: `cli-${shortId(request.requestId, 12)}`,
          severity: "major",
          comment: cleaned || "Rejected",
          status: "open",
        },
      ],
    });
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={error ? colors.err : colors.warn}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text color={colors.warn} bold>
          Action required
        </Text>
        <Text> · {request.nodeId}</Text>
        <Text dimColor> · {request.kind}</Text>
      </Box>
      <Text wrap="wrap">{oneLine(request.summary, 240)}</Text>
      <Text dimColor>request {request.requestId}</Text>

      {mode === "choice" ? (
        <Box marginTop={1} columnGap={2}>
          {choices.map((choice, index) => (
            <Text
              key={choice.value}
              color={index === selected ? "black" : colors.muted}
              backgroundColor={index === selected ? colors.warn : undefined}
              bold={index === selected}
            >
              {" "}
              [{choice.key}] {choice.label}{" "}
            </Text>
          ))}
          {busy ? <Text color={colors.warn}> submitting…</Text> : null}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={colors.warn} bold>
              Rejection reason
            </Text>
            <Text dimColor> (esc to cancel)</Text>
          </Box>
          <Box>
            <Text color={colors.accent}>› </Text>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={submitText}
              focus={!busy}
              placeholder="What should the agent change?"
            />
          </Box>
        </Box>
      )}
      {error ? <Text color={colors.err}>Could not submit: {error}</Text> : null}
    </Box>
  );
}
