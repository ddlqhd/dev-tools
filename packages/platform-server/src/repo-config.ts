import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  CodeloopConfigSchema,
  listBuiltinPipelines,
  loadConfig,
  writeConfig,
  type CodeloopConfig,
} from "@devtools/kernel";

export const AVAILABLE_ENGINES = [
  { id: "cursor", label: "Cursor Agent" },
  { id: "opencode", label: "OpenCode" },
] as const;

export function formatConfigError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function parseRepoConfig(body: unknown): CodeloopConfig {
  return normalizeConfig(CodeloopConfigSchema.parse(body));
}

export function normalizeConfig(config: CodeloopConfig): CodeloopConfig {
  const engines: CodeloopConfig["engines"] = {};
  for (const [key, value] of Object.entries(config.engines)) {
    const model = value.model?.trim();
    engines[key] = {
      type: value.type,
      ...(model ? { model } : {}),
    };
  }
  return { ...config, engines };
}

export async function listRepoPipelines(repoPath: string): Promise<string[]> {
  const builtins = await listBuiltinPipelines();
  let custom: string[] = [];
  try {
    const files = await readdir(join(repoPath, ".codeloop", "pipelines"));
    custom = files.filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
  } catch {
    // no custom pipelines
  }
  return [...new Set([...builtins, ...custom])].sort();
}

export async function loadRepoConfig(
  repoPath: string,
): Promise<{ config: CodeloopConfig; pipelines: string[] }> {
  const [config, pipelines] = await Promise.all([loadConfig(repoPath), listRepoPipelines(repoPath)]);
  return { config, pipelines };
}

export async function saveRepoConfig(repoPath: string, config: CodeloopConfig): Promise<CodeloopConfig> {
  const normalized = normalizeConfig(config);
  await writeConfig(repoPath, normalized);
  return normalized;
}

export async function getConfigMeta(): Promise<{
  pipelines: string[];
  engines: ReadonlyArray<{ id: string; label: string }>;
}> {
  return {
    pipelines: await listBuiltinPipelines(),
    engines: AVAILABLE_ENGINES,
  };
}
