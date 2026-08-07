import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const CodeloopConfigSchema = z.object({
  version: z.literal(1),
  pipeline: z.string().default("m1-minimal"),
  pipelineOverrides: z.record(z.unknown()).optional(),
  engines: z
    .record(
      z.object({
        type: z.string(),
        model: z.string().optional(),
      }),
    )
    .default({
      default: { type: "cursor" },
      reviewer: { type: "cursor" },
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

export const DEFAULT_CONFIG_YAML = `version: 1
pipeline: m1-minimal
engines:
  default:
    type: cursor
  reviewer:
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
