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

export function renderPrompt(template: string, ctx: PromptContext): string {
  switch (template) {
    case "plan":
      return planPrompt(ctx);
    case "code":
      return codePrompt(ctx);
    case "fix":
      return fixPrompt(ctx);
    case "review-plan":
      return reviewPlanPrompt(ctx);
    case "review-code":
      return reviewCodePrompt(ctx);
    case "verify":
      return verifyPrompt(ctx);
    case "commit":
      return commitPrompt(ctx);
    default:
      throw new Error(`Unknown prompt template: ${template}`);
  }
}

function instructionsBlock(instructions: string[]): string {
  if (!instructions.length) return "";
  return `\n\n## Human instructions (must follow)\n${instructions.map((i) => `- ${i}`).join("\n")}`;
}

function planPrompt(ctx: PromptContext): string {
  const prevPlan =
    ctx.planDoc
      ? `\n## Previous plan (revise it rather than start from scratch)\n${ctx.planDoc}`
      : "";
  return `You are an expert planning a software change in this repository. Work through the phases below and finish with a decision-complete plan: a coder must be able to implement it without making any further design decisions.

## Requirement
${ctx.requirement}
${instructionsBlock(ctx.instructions)}
${prevPlan}

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
`;
}

function codePrompt(ctx: PromptContext): string {
  return `You are implementing a software change in this repository.

## Requirement
${ctx.requirement}

## Approved plan
${ctx.planDoc ?? "(no separate plan artifact — infer from requirement)"}
${instructionsBlock(ctx.instructions)}

## Your task
Implement the plan by editing the codebase.
- Prefer minimal, focused changes.
- Follow existing project conventions.
- After coding, briefly summarize what you changed.
- Do not create a git commit (a dedicated commit stage will commit).
`;
}

function fixPrompt(ctx: PromptContext): string {
  return `You are fixing review findings in this repository.

## Requirement
${ctx.requirement}

## Open review comments (JSON)
${ctx.reviewComments ?? "[]"}
${instructionsBlock(ctx.instructions)}

## Your task
Address each open comment. Prefer fixing code over arguing.
If you intentionally reject a comment, note why in your final summary.
Do not create a git commit (a dedicated commit stage will commit).
`;
}

function reviewPlanPrompt(ctx: PromptContext): string {
  return `You are reviewing an implementation plan.

## Requirement
${ctx.requirement}

## Plan to review
${ctx.planDoc ?? ""}
${instructionsBlock(ctx.instructions)}

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
`;
}

function verifyPrompt(ctx: PromptContext): string {
  return `You are verifying that the change in this repository is sound.

## Requirement
${ctx.requirement}

## Plan (context)
${ctx.planDoc ?? "(none)"}
${instructionsBlock(ctx.instructions)}

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
`;
}

function commitPrompt(ctx: PromptContext): string {
  const style = ctx.messageStyle ?? "conventional";
  return `You are creating the final git commit for a finished change in this repository.

## Requirement
${ctx.requirement}

## Plan (context)
${ctx.planDoc ?? "(none)"}
${instructionsBlock(ctx.instructions)}

## Repository state
- branch: ${ctx.branch ?? "(current)"}
- base commit (exclusive): ${ctx.baseCommit ?? "(unknown)"}
- All work is already committed as one or more WIP commits on top of that base.

## Your task
1. Inspect the change: \`git log --oneline ${ctx.baseCommit ?? "<base>"}..HEAD\` and
   \`git diff ${ctx.baseCommit ?? "<base>"}..HEAD --stat\` (read the diff itself where useful).
2. Collapse every commit after the base into exactly one commit with an identical tree:
   \`\`\`
   git reset --soft ${ctx.baseCommit ?? "<base>"}
   git -c user.name=codeloop-engine -c user.email=engine@codeloop.local commit -m "<message>"
   \`\`\`
3. Write the message in ${style} style, describing what the change actually does:
   a subject line under 72 characters, then a blank line and a short body when the
   change warrants one.

## Hard rules
- Do NOT create, edit or delete any file. The tree must stay byte-identical.
- Do NOT touch the base commit or any commit before it. Do NOT push. Do NOT amend
  after committing, and do NOT create a second commit.
- Leave the worktree clean.

Afterwards the orchestrator checks: worktree clean, exactly one commit in
${ctx.baseCommit ?? "<base>"}..HEAD, and the HEAD tree unchanged. Anything else fails the stage.
`;
}

function reviewCodePrompt(ctx: PromptContext): string {
  return `You are reviewing code changes for the requirement below.

## Requirement
${ctx.requirement}

## Plan (context)
${ctx.planDoc ?? "(none)"}
${instructionsBlock(ctx.instructions)}

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
`;
}
