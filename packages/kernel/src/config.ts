import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { resolveNodeEngineKey, type NodeSpec } from "@devtools/shared";

export const CodeloopConfigSchema = z.object({
  version: z.literal(1),
  pipeline: z.string().default("default-codeloop"),
  pipelineOverrides: z.record(z.unknown()).optional(),
  engines: z
    .record(
      z.object({
        type: z.string(),
        model: z.string().optional(),
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

export const DEFAULT_CONFIG_YAML = `version: 1
pipeline: default-codeloop
# Stage engines: assign different models for cross-review.
# List available model ids with: agent --list-models
engines:
  planner:
    type: cursor
    # model: <strong reasoning model>
  planReviewer:
    type: cursor
    # model: <different from planner>
  coder:
    type: cursor
  codeReviewer:
    type: cursor
    # model: <different from coder>
  fixer:
    type: cursor
  # Runs the project's own checks and reports; needs command execution.
  verifier:
    type: cursor
  # Squashes the work into one commit and writes the message.
  committer:
    type: cursor
budget:
  maxEngineCalls: 60
  nodeTimeoutMinutes: 30
git:
  branchPrefix: codeloop/
  worktreeRoot: .codeloop/worktrees
autoApproveGates: false
skipVerifyIfMissing: true
`;

export async function ensureCodeloopDir(repoPath: string): Promise<string> {
  const root = join(repoPath, ".codeloop");
  await mkdir(join(root, "pipelines"), { recursive: true });
  await mkdir(join(root, "worktrees"), { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });

  const configPath = join(root, "config.yaml");
  try {
    await readFile(configPath, "utf8");
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
