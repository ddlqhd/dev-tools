import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parse as parseYaml, parseDocument, Scalar, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { resolveNodeEngineKey, type NodeSpec } from "@devtools/shared";
import { DEFAULT_ENGINE_ALIASES, DEFAULT_PROMPTS } from "./prompts/index.js";

export const CodeloopConfigSchema = z.object({
  version: z.literal(1),
  pipeline: z.string().default("default-codeloop"),
  pipelineOverrides: z.record(z.unknown()).optional(),
  engines: z
    .record(
      z.object({
        type: z.string(),
        model: z.string().optional(),
        prompt: z.string().optional(),
      }),
    )
    .default({
      planner: { type: "cursor" },
      planReviewer: { type: "cursor" },
      coder: { type: "cursor" },
      codeReviewer: { type: "cursor" },
      fixer: { type: "cursor" },
      verifier: { type: "cursor" },
      committer: { type: "cursor" },
    }),
  budget: z
    .object({
      maxEngineCalls: z.number().int().positive().default(60),
      nodeTimeoutMinutes: z.number().int().positive().default(30),
    })
    .default({ maxEngineCalls: 60, nodeTimeoutMinutes: 30 }),
  git: z
    .object({
      branchPrefix: z.string().default("codeloop/"),
      worktreeRoot: z.string().default(".codeloop/worktrees"),
    })
    .default({ branchPrefix: "codeloop/", worktreeRoot: ".codeloop/worktrees" }),
  autoApproveGates: z.boolean().default(false),
  skipVerifyIfMissing: z.boolean().default(true),
  /**
   * Run the task in the repository itself instead of a dedicated linked worktree.
   * Commits land on the current branch; never runs `reset --hard` / `clean -fd`.
   */
  inplace: z.boolean().default(false),
  /** Sandbox write-mode engine turns. Verify/commit turns always run unsandboxed. */
  sandbox: z.boolean().default(false),
});

export type CodeloopConfig = z.infer<typeof CodeloopConfigSchema>;

export function getMissingEngineConfigs(
  nodes: Record<string, NodeSpec>,
  engines: CodeloopConfig["engines"],
): string[] {
  const required = new Set<string>();
  for (const node of Object.values(nodes)) {
    const engine = resolveNodeEngineKey(node);
    if (engine) required.add(engine);
  }
  return [...required].filter((engine) => !engines[engine]);
}

const ENGINE_PREAMBLE: Record<string, string> = {
  planner: "    # model: <strong reasoning model>\n",
  planReviewer:
    "    # model: <different from planner>\n    # Must still write .codeloop-review.json — changing the filename breaks the runner.\n",
  coder: "",
  codeReviewer:
    "    # model: <different from coder>\n    # Must still write .codeloop-review.json — changing the filename breaks the runner.\n",
  fixer: "",
  verifier:
    "    # Must still write .codeloop-verify.json — changing the filename breaks the runner.\n",
  committer: "",
};

function yamlBlock(text: string, indent: number): string {
  const pad = " ".repeat(indent);
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => (line.length ? pad + line : ""))
    .join("\n");
}

function defaultEngineYaml(): string {
  const blocks: string[] = [];
  for (const alias of DEFAULT_ENGINE_ALIASES) {
    if (alias === "verifier") {
      blocks.push("  # Runs the project's own checks and reports; needs command execution.");
    } else if (alias === "committer") {
      blocks.push("  # Squashes the work into one commit and writes the message.");
    }
    blocks.push(`  ${alias}:`);
    blocks.push("    type: cursor");
    const extra = ENGINE_PREAMBLE[alias];
    if (extra) blocks.push(extra.replace(/\n$/, ""));
    blocks.push("    prompt: |");
    blocks.push(yamlBlock(DEFAULT_PROMPTS[alias], 6));
  }
  return blocks.join("\n");
}

export const DEFAULT_CONFIG_YAML = `version: 1
pipeline: default-codeloop
# Stage engines: assign different models for cross-review.
# List available model ids with: agent --list-models (cursor) or: opencode models (opencode)
# Each alias also carries the stage prompt ({{requirement}}, {{planDoc}}, …).
engines:
${defaultEngineYaml()}
budget:
  maxEngineCalls: 60
  nodeTimeoutMinutes: 30
git:
  branchPrefix: codeloop/
  worktreeRoot: .codeloop/worktrees
autoApproveGates: false
skipVerifyIfMissing: true
# Work directly in the repo (no worktree). Commits land on the current branch;
# does not reset --hard / clean -fd the working tree.
inplace: false
# Sandbox write-mode engine turns (verify/commit always run unsandboxed).
sandbox: false
`;

/** Insert default prompts under existing engine aliases that lack a non-empty prompt. */
export function backfillEnginePrompts(raw: string): string {
  const doc = parseDocument(raw);
  if (doc.errors.length) return raw;
  const engines = doc.get("engines");
  if (!isMap(engines)) return raw;

  let changed = false;
  for (const alias of DEFAULT_ENGINE_ALIASES) {
    const entry = engines.get(alias);
    if (!isMap(entry)) continue;
    const existing = entry.get("prompt");
    if (typeof existing === "string" && existing.trim()) continue;
    const scalar = new Scalar(DEFAULT_PROMPTS[alias]);
    scalar.type = "BLOCK_LITERAL";
    entry.set("prompt", scalar);
    changed = true;
  }
  return changed ? String(doc) : raw;
}

export async function ensureCodeloopDir(repoPath: string): Promise<string> {
  const root = join(repoPath, ".codeloop");
  await mkdir(join(root, "pipelines"), { recursive: true });
  await mkdir(join(root, "worktrees"), { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });

  const configPath = join(root, "config.yaml");
  try {
    const existing = await readFile(configPath, "utf8");
    const updated = backfillEnginePrompts(existing);
    if (updated !== existing) {
      await writeFile(configPath, updated, "utf8");
    }
  } catch {
    await writeFile(configPath, DEFAULT_CONFIG_YAML, "utf8");
  }

  // Ensure .codeloop is gitignored in the target repo
  const gi = join(repoPath, ".gitignore");
  try {
    const content = await readFile(gi, "utf8");
    if (!content.split("\n").some((l) => l.trim() === ".codeloop/" || l.trim() === ".codeloop")) {
      await writeFile(gi, `${content.trimEnd()}\n\n.codeloop/\n`, "utf8");
    }
  } catch {
    // no gitignore — skip
  }

  return root;
}

export async function loadConfig(repoPath: string): Promise<CodeloopConfig> {
  await ensureCodeloopDir(repoPath);
  const raw = await readFile(join(repoPath, ".codeloop", "config.yaml"), "utf8");
  return CodeloopConfigSchema.parse(parseYaml(raw));
}

export async function writeConfig(repoPath: string, config: CodeloopConfig): Promise<void> {
  await ensureCodeloopDir(repoPath);
  await writeFile(
    join(repoPath, ".codeloop", "config.yaml"),
    stringifyYaml(config),
    "utf8",
  );
}
