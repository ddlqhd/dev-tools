import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROMPTS, renderPrompt, type PromptContext } from "../src/prompts/index.js";

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return { requirement: "add a flag", instructions: [], ...over };
}

test("renderPrompt: interpolates known placeholders", () => {
  const out = renderPrompt("coder", ctx({ planDoc: "Step 1" }), "Req: {{requirement}}\nPlan: {{planDoc}}");
  assert.equal(out, "Req: add a flag\nPlan: Step 1");
});

test("renderPrompt: unknown placeholders stay put", () => {
  const out = renderPrompt("coder", ctx(), "keep {{notAVar}} here");
  assert.equal(out, "keep {{notAVar}} here");
});

test("renderPrompt: empty body falls back to the built-in alias", () => {
  const out = renderPrompt("planner", ctx(), "   ");
  assert.match(out, /planning a software change/);
  assert.match(out, /## Requirement\nadd a flag/);
});

test("renderPrompt: missing body uses DEFAULT_PROMPTS", () => {
  const out = renderPrompt("fixer", ctx({ reviewComments: '[{"id":"1"}]' }));
  assert.equal(
    out,
    renderPrompt("fixer", ctx({ reviewComments: '[{"id":"1"}]' }), DEFAULT_PROMPTS.fixer),
  );
  assert.match(out, /Open review comments \(JSON\)\n\[\{"id":"1"\}\]/);
});

test("renderPrompt: unknown alias without a body throws", () => {
  assert.throws(() => renderPrompt("myBot", ctx()), /Unknown prompt template: myBot/);
});

test("renderPrompt: custom alias with a body is allowed", () => {
  const out = renderPrompt("myBot", ctx(), "do {{requirement}}");
  assert.equal(out, "do add a flag");
});

test("renderPrompt: custom body wins over the built-in", () => {
  const out = renderPrompt("planner", ctx(), "only {{requirement}}");
  assert.equal(out, "only add a flag");
});

test("renderPrompt: instructions and previousPlan are omitted when empty", () => {
  const out = renderPrompt("planner", ctx());
  assert.doesNotMatch(out, /Human instructions/);
  assert.doesNotMatch(out, /Previous plan/);
});

test("renderPrompt: instructions and previousPlan expand when present", () => {
  const out = renderPrompt(
    "planner",
    ctx({ instructions: ["use zod"], planDoc: "old plan text" }),
  );
  assert.match(out, /## Human instructions \(must follow\)\n- use zod/);
  assert.match(out, /## Previous plan \(revise it rather than start from scratch\)\nold plan text/);
});

test("renderPrompt: coder planDoc fallback matches the previous hardcoded text", () => {
  const out = renderPrompt("coder", ctx());
  assert.match(out, /no separate plan artifact — infer from requirement/);
});
