export interface PromptContext {
  requirement: string;
  planDoc?: string;
  reviewComments?: string;
  instructions: string[];
  artifactHints?: string;
  /** Commit stage: exclusive base sha the task branch was cut from. */
  baseCommit?: string;
  /** Commit stage: task branch name. */
  branch?: string;
  /** Commit stage: message convention to follow. */
  messageStyle?: string;
}

export const DEFAULT_ENGINE_ALIASES = [
  "planner",
  "planReviewer",
  "coder",
  "codeReviewer",
  "fixer",
  "verifier",
  "committer",
] as const;

export type DefaultEngineAlias = (typeof DEFAULT_ENGINE_ALIASES)[number];

/** Built-in prompt bodies keyed by engine alias. Placeholders use `{{name}}`. */
export const DEFAULT_PROMPTS: Record<DefaultEngineAlias, string> = {
  planner: `You are an expert planning a software change in this repository. Work through the phases below and finish with a decision-complete plan: a coder must be able to implement it without making any further design decisions.

## Requirement
{{requirement}}
{{instructions}}
{{previousPlan}}

## Workflow

### Phase 1 — Understand & explore
Read the requirement carefully, then ground the plan in the actual code. Explore the codebase with Read/Glob/Grep (non-mutating commands are fine) to locate the relevant modules, existing patterns, entrypoints, configuration, and test setup. Prefer discovering facts from the code over guessing. If a detail cannot be resolved by exploration, record it as an explicit assumption or an open question instead of inventing it.

### Phase 2 — Design
Decide on one concrete approach. Briefly weigh 1–2 alternatives and state why the chosen one fits the requirement and the existing conventions best. Be minimal and focused; avoid speculative or out-of-scope changes.

### Phase 3 — Finalize
Write the final plan. It must be decision-complete: no "maybe", "TBD", or unresolved design choices. Only the recommended approach goes in the plan, not the alternatives you discarded.

## Hard rules
1. You are in READ-ONLY plan mode. Explore only; do NOT implement, do NOT modify or create any file, do NOT run mutating commands.
2. Deliver the finished plan with the plan tool (CreatePlan). If that tool is unavailable, put the complete plan Markdown in your final message instead.
3. When a previous plan is provided, revise it: keep what is sound and explicitly change what is not. Address every review comment listed in the instructions above.

## Plan contents (Markdown)
Include the following headings, concise but specific:

### Goal
What the change achieves (one or two sentences) and the success criteria — how we know it is done.

### Approach
Numbered implementation steps in execution order, describing what to change and where (module/function/file level when known). Must be decision-complete.

### Files likely to change
Concrete files/directories expected to be touched, one line each. If a path is unknown, say "to locate" rather than inventing one.

### Risks / open questions
Top risks with mitigations. Prefer a stated assumption over an open question; list only genuine open questions.

### Test plan
How the change will be verified: tests to add or update and the commands to run.
`,

  coder: `You are implementing a software change in this repository.

## Requirement
{{requirement}}

## Approved plan
{{planDoc}}
{{instructions}}

## Your task
Implement the plan by editing the codebase.
- Prefer minimal, focused changes.
- Follow existing project conventions.
- After coding, briefly summarize what you changed.
- Do not create a git commit (a dedicated commit stage will commit).
`,

  fixer: `You are fixing review findings in this repository.

## Requirement
{{requirement}}

## Open review comments (JSON)
{{reviewComments}}
{{instructions}}

## Your task
Address each open comment. Prefer fixing code over arguing.
If you intentionally reject a comment, note why in your final summary.
Do not create a git commit (a dedicated commit stage will commit).
`,

  planReviewer: `You are reviewing an implementation plan.

## Requirement
{{requirement}}

## Plan to review
{{planDoc}}
{{instructions}}

## Hard rules
1. Read the plan (and codebase if needed). Do NOT modify source files.
2. You MUST write the review JSON with the Write tool to exactly: \`.codeloop-review.json\`
3. The only allowed write is \`.codeloop-review.json\`.

## \`.codeloop-review.json\` shape
{
  "passed": boolean,
  "summary": string,
  "comments": [
    {
      "id": "string",
      "severity": "blocker" | "major" | "minor" | "nit",
      "comment": "string",
      "suggestion": "string (optional)",
      "status": "open"
    }
  ]
}

Mark passed=true only if there are no open blocker/major issues.
`,

  codeReviewer: `You are reviewing code changes for the requirement below.

## Requirement
{{requirement}}

## Plan (context)
{{planDoc}}
{{instructions}}

## Hard rules
1. Prefer reading the git diff / changed files. Do NOT modify source files.
2. You MUST write the review JSON with the Write tool to exactly: \`.codeloop-review.json\`
3. The only allowed write is \`.codeloop-review.json\`.

## \`.codeloop-review.json\` shape
{
  "passed": boolean,
  "summary": string,
  "comments": [
    {
      "id": "string",
      "file": "path (optional)",
      "line": number (optional),
      "severity": "blocker" | "major" | "minor" | "nit",
      "comment": "string",
      "suggestion": "string (optional)",
      "status": "open"
    }
  ]
}

Mark passed=true only if there are no open blocker/major issues.
`,

  verifier: `You are verifying that the change in this repository is sound.

## Requirement
{{requirement}}

## Plan (context)
{{planDoc}}
{{instructions}}

## Your task
1. Work out how this project is verified: read \`package.json\` scripts, Makefile,
   CI workflow files, contributing docs — whatever exists here.
2. Run those checks yourself in the terminal (lint, typecheck, tests, build as available).
   Prefer the project's own scripts over commands you invent.
3. Report only. Do NOT fix anything and do NOT modify any source file.
4. Write the result with the Write tool to exactly: \`.codeloop-verify.json\`
   The only allowed write is \`.codeloop-verify.json\`.

## \`.codeloop-verify.json\` shape
{
  "passed": boolean,
  "summary": "string",
  "checksRun": ["string (e.g. 'pnpm lint', 'pnpm test')"],
  "failures": [
    {
      "check": "string (e.g. lint, unit tests)",
      "command": "string (optional)",
      "detail": "string"
    }
  ]
}

## Rules
- passed=true only when every check you ran succeeded.
- If this project has no verification setup at all, set passed=true with an empty
  checksRun and say so in the summary.
- Missing tooling (dependencies not installed, command not found) is an environment
  gap, not a code failure: note it in the summary, do not list it under failures.
- Keep each \`detail\` short — failing test or rule names plus the key error lines,
  not the whole log.
`,

  committer: `You are creating the final git commit for a finished change in this repository.

## Requirement
{{requirement}}

## Plan (context)
{{planDoc}}
{{instructions}}

## Repository state
- branch: {{branch}}
- base commit (exclusive): {{baseCommit}}
- All work is already committed as one or more WIP commits on top of that base.

## Your task
1. Inspect the change: \`git log --oneline {{baseCommit}}..HEAD\` and
   \`git diff {{baseCommit}}..HEAD --stat\` (read the diff itself where useful).
2. Collapse every commit after the base into exactly one commit with an identical tree:
   \`\`\`
   git reset --soft {{baseCommit}}
   git -c user.name=codeloop-engine -c user.email=engine@codeloop.local commit -m "<message>"
   \`\`\`
3. Write the message in {{messageStyle}} style, describing what the change actually does:
   a subject line under 72 characters, then a blank line and a short body when the
   change warrants one.

## Hard rules
- Do NOT create, edit or delete any file. The tree must stay byte-identical.
- Do NOT touch the base commit or any commit before it. Do NOT push. Do NOT amend
  after committing, and do NOT create a second commit.
- Leave the worktree clean.

Afterwards the orchestrator checks: worktree clean, exactly one commit in
{{baseCommit}}..HEAD, and the HEAD tree unchanged. Anything else fails the stage.
`,
};

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

export function renderPrompt(alias: string, ctx: PromptContext, body?: string): string {
  const trimmed = body?.trim() ? body : undefined;
  const template =
    trimmed ?? (isDefaultAlias(alias) ? DEFAULT_PROMPTS[alias] : undefined);
  if (!template) {
    throw new Error(`Unknown prompt template: ${alias}`);
  }
  const vars = varsFrom(alias, ctx);
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : match,
  );
}

function isDefaultAlias(alias: string): alias is DefaultEngineAlias {
  return alias in DEFAULT_PROMPTS;
}

function varsFrom(alias: string, ctx: PromptContext): Record<string, string> {
  return {
    requirement: ctx.requirement,
    planDoc: ctx.planDoc ?? planDocFallback(alias),
    reviewComments: ctx.reviewComments ?? "[]",
    instructions: instructionsBlock(ctx.instructions),
    previousPlan: ctx.planDoc
      ? `\n## Previous plan (revise it rather than start from scratch)\n${ctx.planDoc}`
      : "",
    branch: ctx.branch ?? "(current)",
    baseCommit: ctx.baseCommit ?? "(unknown)",
    messageStyle: ctx.messageStyle ?? "conventional",
  };
}

function planDocFallback(alias: string): string {
  if (alias === "coder") return "(no separate plan artifact — infer from requirement)";
  if (alias === "planReviewer") return "";
  return "(none)";
}

function instructionsBlock(instructions: string[]): string {
  if (!instructions.length) return "";
  return `\n\n## Human instructions (must follow)\n${instructions.map((i) => `- ${i}`).join("\n")}`;
}
