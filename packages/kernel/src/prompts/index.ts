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

## Your task
1. Explore the codebase as needed (read-only).
2. Write a concise implementation plan as Markdown.
3. Save the plan to the file path given below — create/overwrite that exact file.
4. Do NOT modify any other source files in this turn.

## Output file (required)
Write the full plan Markdown to: \`.codeloop-plan.md\`

The plan MUST include:
- Goal
- Approach (steps)
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
  return `You are reviewing an implementation plan. Read-only — do not edit code.

## Requirement
${ctx.requirement}

## Plan to review
${ctx.planDoc ?? ""}
${instructionsBlock(ctx.instructions)}

## Output
Write a JSON file to \`.codeloop-review.json\` with this exact shape:
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

Mark passed=true only if there are no blocker/major issues.
`;
}

function reviewCodePrompt(ctx: PromptContext): string {
  return `You are reviewing code changes for the requirement below. Prefer reading the git diff / changed files. Do not edit code.

## Requirement
${ctx.requirement}

## Plan (context)
${ctx.planDoc ?? "(none)"}
${instructionsBlock(ctx.instructions)}

## Output
Write a JSON file to \`.codeloop-review.json\` with this exact shape:
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

Mark passed=true only if there are no blocker/major issues (unless severity gate is lower — still report all findings).
`;
}
