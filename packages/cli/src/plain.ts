import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  ReviewComment,
} from "@devtools/shared";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** Streaming renderer used for pipes, CI, `--plain`, and offline replay. */
export class PlainRenderer {
  private streamKind: "text" | "thinking" | null = null;
  private streamAtLineStart = true;
  private readonly color = process.stdout.isTTY === true;

  print = (event: KernelEvent): void => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === "engine.chunk") {
      const chunk = payload.chunk as { kind?: string; text?: string };
      if (chunk.kind === "text" || chunk.kind === "thinking") {
        this.writeStream(chunk.kind, chunk.text ?? "");
        return;
      }
    }
    this.end();

    switch (event.type) {
      case "task.created":
        console.log(
          `[task] created pipeline=${String((payload.pipeline as { name?: string })?.name ?? "-")}`,
        );
        break;
      case "task.started":
        console.log("[task] started");
        break;
      case "task.resumed":
        console.log(`[task] resumed @ ${String(payload.nodeId ?? "-")}`);
        break;
      case "task.suspended":
        console.log(`[task] suspended: ${String(payload.reason ?? "")}`);
        break;
      case "task.completed":
        console.log("[task] completed");
        break;
      case "task.failed":
        console.log(`[task] failed: ${String(payload.error ?? "")}`);
        break;
      case "task.aborted":
        console.log("[task] aborted");
        break;
      case "node.started": {
        const engine = payload.engine ? String(payload.engine) : undefined;
        const model = payload.model ? String(payload.model) : undefined;
        const meta = [engine, model].filter(Boolean).join("/");
        console.log(
          `[node] ▶ ${String(payload.nodeId)} (${String(payload.primitive)}${meta ? `, ${meta}` : ""})`,
        );
        break;
      }
      case "node.completed":
        console.log(`[node] ✓ ${String(payload.nodeId)}`);
        break;
      case "node.retrying":
        console.log(
          `[node] retry ${String(payload.nodeId)} attempt=${String(payload.attempt)}: ${String(payload.error)}`,
        );
        break;
      case "loop.iteration":
        console.log(
          `[loop] ${String(payload.loopId)} ${String(payload.iteration)}/${String(payload.maxIterations)}`,
        );
        break;
      case "engine.chunk": {
        const chunk = payload.chunk as {
          kind?: string;
          tool?: string;
          summary?: string;
          path?: string;
          op?: string;
        };
        if (chunk.kind === "toolUse") {
          console.log(`  ⚙ ${chunk.tool ?? ""} ${chunk.summary ?? ""}`);
        } else if (chunk.kind === "fileChange") {
          console.log(`  ✎ ${chunk.path ?? ""}${chunk.op ? ` (${chunk.op})` : ""}`);
        }
        break;
      }
      case "git.commit": {
        const message = String(payload.message ?? "").split("\n")[0] ?? "";
        console.log(`[git] commit ${String(payload.sha ?? "").slice(0, 8)} — ${message}`);
        break;
      }
      case "review.completed":
        console.log(
          `[review] passed=${String(payload.passed)} comments=${Array.isArray(payload.comments) ? payload.comments.length : 0}`,
        );
        break;
      case "intervention.required":
        console.log(
          `[intervene] ${String(payload.kind)}: ${String(payload.summary)} (${String(payload.requestId)})`,
        );
        break;
      case "intervention.resolved":
        console.log(
          `[intervene] resolved ${String((payload.decision as { action?: string })?.action ?? "")}`,
        );
        break;
      case "instruction.injected":
        console.log(`[inject] ${String(payload.text ?? "")}`);
        break;
      case "artifact.created":
        console.log(`[artifact] ${String(payload.key ?? "")} → ${String(payload.path ?? "")}`);
        break;
      case "log":
        console.log(`[log] ${String(payload.message ?? "")}`);
        break;
      case "budget.warning":
        console.log(`[budget] warning ${formatBudget(payload)}`);
        break;
      case "budget.exceeded":
        console.log(`[budget] exceeded ${formatBudget(payload)}`);
        break;
      default:
        break;
    }
  };

  end(): void {
    if (!this.streamKind) return;
    if (this.color) process.stdout.write(RESET);
    if (!this.streamAtLineStart) process.stdout.write("\n");
    this.streamKind = null;
    this.streamAtLineStart = true;
  }

  private writeStream(kind: "text" | "thinking", text: string): void {
    if (!text) return;
    if (this.streamKind !== kind) {
      this.end();
      this.streamKind = kind;
      if (this.color && kind === "thinking") process.stdout.write(DIM);
    }
    process.stdout.write(text);
    this.streamAtLineStart = text.endsWith("\n");
  }
}

export async function promptPlainIntervention(
  request: InterventionRequest,
  options: { signal?: AbortSignal; onInterrupt?: () => void } = {},
): Promise<InterventionDecision> {
  console.log("");
  console.log(`── Intervention required (${request.kind}) @ ${request.nodeId}`);
  console.log(`   ${request.summary}`);
  console.log(`   requestId=${request.requestId}`);
  const readline = createInterface({ input, output });
  const interrupt = () => {
    options.onInterrupt?.();
    if (!options.signal) readline.close();
  };
  readline.on("SIGINT", interrupt);
  const signal = options.signal;
  const question = signal
    ? (prompt: string) => readline.question(prompt, { signal })
    : (prompt: string) => readline.question(prompt);
  try {
    for (;;) {
      const answer = (await question("Approve / Reject [a/r]? ")).trim().toLowerCase();
      if (answer === "a" || answer === "approve" || answer === "") {
        return { action: "approve" };
      }
      if (answer === "r" || answer === "reject") {
        const message = await question("Rejection comments: ");
        const comments: ReviewComment[] = [
          {
            id: "cli-reject",
            severity: "major",
            comment: message || "Rejected",
            status: "open",
          },
        ];
        return { action: "reject", comments };
      }
      console.log("Please answer a or r.");
    }
  } finally {
    readline.off("SIGINT", interrupt);
    readline.close();
  }
}

export interface RunSummary {
  taskId: string;
  status: string;
  branch: string;
  worktreePath: string;
  error?: string;
}

export function printRunHeader(
  repoPath: string,
  pipeline: string | undefined,
  requirement: string,
): void {
  console.log(`repo: ${repoPath}`);
  console.log(`pipeline: ${pipeline ?? "(config default)"}`);
  console.log(
    `requirement: ${requirement.slice(0, 120)}${requirement.length > 120 ? "…" : ""}`,
  );
  console.log("---");
}

export function printRunSummary(result: RunSummary, repoPath: string): void {
  console.log("---");
  console.log(`task: ${result.taskId}`);
  console.log(`status: ${result.status}`);
  console.log(`branch: ${result.branch}`);
  console.log(
    result.worktreePath === repoPath
      ? `worktree: (inplace) ${result.worktreePath}`
      : `worktree: ${result.worktreePath}`,
  );
  if (result.error) console.error(`error: ${result.error}`);
}

function formatBudget(payload: Record<string, unknown>): string {
  return ["metric", "used", "limit", "reason"]
    .filter((key) => payload[key] !== undefined)
    .map((key) => `${key}=${String(payload[key])}`)
    .join(" ");
}
