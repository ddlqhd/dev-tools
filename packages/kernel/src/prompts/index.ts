export interface PromptContext {
  requirement: string;
  planDoc?: string;
  reviewComments?: string;
  instructions: string[];
  artifactHints?: string;
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
    default:
      throw new Error(`Unknown prompt template: ${template}`);
  }
}

function instructionsBlock(instructions: string[]): string {
  if (!instructions.length) return "";
  return `\n\n## Human instructions (must follow)\n${instructions.map((i) => `- ${i}`).join("\n")}`;
}

function planPrompt(ctx: PromptContext): string {
  return `You are planning a software change in this repository.

## Requirement
${ctx.requirement}
${instructionsBlock(ctx.instructions)}

## Hard rules
1. Explore the codebase with Read/Glob as needed.
2. You MUST create/overwrite the file \`.codeloop-plan.md\` using the **Write** tool (not CreatePlan / createPlanToolCall / plan mode UI).
3. Do NOT modify any other files. The only allowed write is \`.codeloop-plan.md\`.
4. After writing the file, stop. Do not implement the change.

## \`.codeloop-plan.md\` contents (Markdown)
Must include these headings:
- Goal
- Approach (numbered steps)
- Files likely to change
- Risks / open questions
- Test plan
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
- Do not create a git commit (the orchestrator will commit).
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
Do not create a git commit.
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
