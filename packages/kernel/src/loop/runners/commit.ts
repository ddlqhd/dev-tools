import { resolveNodeEngineKey, type NodeSpec } from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import { dropOrchestratorTempFiles } from "../artifact-guard.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const MAX_ATTEMPTS = 3;

/**
 * The agent reads the accumulated work and squashes it into one commit with a
 * message it writes itself. The orchestrator only enforces the invariants
 * afterwards: clean worktree, exactly one commit on the base, unchanged tree.
 */
export class CommitNodeRunner implements NodeRunner {
  readonly type = "commit" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (!ctx.engine) throw new Error("commit node requires an engine session");

    const base = ctx.worktree.baseCommit;
    await dropOrchestratorTempFiles(ctx.worktree.worktreePath);

    // Fold stray uncommitted work in, so "everything lives in base..HEAD" holds
    // and the tree check below has something stable to compare against.
    if ((await ctx.worktree.statusPorcelain()).trim()) {
      await ctx.worktree.addAllAndCommit("codeloop: wip pre-commit", "engine");
    }

    const expectedTree = await ctx.worktree.treeHash("HEAD");
    const commitsToSquash = await ctx.worktree.commitCountSince(base);

    if (commitsToSquash === 0) {
      await ctx.emit({
        type: "log",
        payload: { level: "warn", message: "Nothing to commit — no changes on top of base" },
      });
      const sha = await ctx.worktree.head();
      return {
        outputs: {},
        outcome: { sha, message: "", branch: ctx.worktree.branch, skipped: true },
      };
    }

    const planDoc = await ctx.artifacts.readText("planDoc");
    const engineKey = resolveNodeEngineKey(spec);
    if (!engineKey) throw new Error("commit node requires an engine alias");
    const prompt = renderPrompt(engineKey, {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      instructions: ctx.instructions,
      baseCommit: base,
      branch: ctx.worktree.branch,
      messageStyle: spec.messageStyle ?? "conventional",
    }, ctx.config.engines[engineKey]?.prompt);

    const preHead = await ctx.worktree.head();
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const turnPrompt =
        attempt === 0
          ? prompt
          : [
              "Your previous attempt left the branch in an invalid state and it has been rolled back.",
              `Reason: ${lastError}`,
              "Try again, following the rules exactly.",
              "",
              prompt,
            ].join("\n");

      const result = await ctx.engine.send(turnPrompt, (chunk) => {
        void ctx.emit({
          type: "engine.chunk",
          payload: { nodeId: nodeId(ctx), chunk },
        });
      });
      await ctx.emit({
        type: "engine.turn.completed",
        payload: {
          nodeId: nodeId(ctx),
          engineType: ctx.engineType,
          usage: result.usage,
          filesChanged: result.filesChanged,
        },
      });

      const violation = await findViolation(ctx, base, expectedTree);
      if (violation) {
        lastError = violation;
        await ctx.emit({
          type: "log",
          payload: { level: "warn", message: `commit rejected: ${violation}` },
        });
        try {
          await ctx.worktree.resetHard(preHead);
        } catch {
          // best effort
        }
        continue;
      }

      const sha = await ctx.worktree.head();
      const message = await ctx.worktree.lastCommitMessage();

      await ctx.emit({
        type: "git.commit",
        payload: { sha, message: firstLine(message), author: "engine" },
      });
      await ctx.emit({
        type: "log",
        payload: {
          level: "info",
          message: `Squashed ${commitsToSquash} commit(s) onto ${base.slice(0, 8)} → ${sha.slice(0, 8)}`,
        },
      });

      return {
        outputs: {},
        outcome: { sha, message: firstLine(message), branch: ctx.worktree.branch },
      };
    }

    throw new Error(`Commit stage failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }
}

/** Returns a description of the broken invariant, or undefined when all hold. */
async function findViolation(
  ctx: NodeContext,
  base: string,
  expectedTree: string,
): Promise<string | undefined> {
  const status = await ctx.worktree.statusPorcelain();
  if (status.trim()) {
    return `worktree is not clean:\n${status.trim()}`;
  }

  const count = await ctx.worktree.commitCountSince(base);
  if (count !== 1) {
    return `expected exactly 1 commit in ${base.slice(0, 8)}..HEAD, found ${count}`;
  }

  const tree = await ctx.worktree.treeHash("HEAD");
  if (tree !== expectedTree) {
    return `the committed tree differs from the verified one (expected ${expectedTree.slice(0, 8)}, got ${tree.slice(0, 8)}) — no file may change during the commit stage`;
  }

  const message = await ctx.worktree.lastCommitMessage();
  if (!firstLine(message).trim() || /^codeloop: wip/i.test(message)) {
    return `commit message is missing or still a WIP placeholder: "${firstLine(message)}"`;
  }

  return undefined;
}

function firstLine(message: string): string {
  return message.split("\n").find((l) => l.trim()) ?? message;
}

function nodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
