import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const PlatformConfigSchema = z.object({
  dataDir: z.string().default(".platform"),
  reposCache: z.string().default(".platform/repos"),
  listen: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().default(4800),
    })
    .default({ host: "127.0.0.1", port: 4800 }),
  github: z
    .object({
      token: z.string().optional(),
      webhookSecret: z.string().optional(),
    })
    .default({}),
  scheduler: z
    .object({
      globalMaxInstances: z.number().int().positive().default(2),
      pollIntervalMs: z.number().int().positive().default(300_000),
      tickMs: z.number().int().positive().default(3_000),
    })
    .default({ globalMaxInstances: 2, pollIntervalMs: 300_000, tickMs: 3_000 }),
  /** argv for spawning codeloop, e.g. ["node", "packages/cli/dist/index.js"] */
  codeloopBin: z
    .union([z.string(), z.array(z.string())])
    .default(["node", "packages/cli/dist/index.js"]),
  platformToken: z.string().optional(),
  consoleBaseUrl: z.string().optional(),
  defaultBaseBranch: z.string().default("main"),
  webDist: z.string().optional(),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

const DEFAULT_YAML = `dataDir: .platform
reposCache: .platform/repos
listen:
  host: 127.0.0.1
  port: 4800
github: {}
scheduler:
  globalMaxInstances: 2
  pollIntervalMs: 300000
  tickMs: 3000
codeloopBin:
  - node
  - packages/cli/dist/index.js
defaultBaseBranch: main
`;

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

export async function loadPlatformConfig(cwd = process.cwd()): Promise<PlatformConfig> {
  const path = join(cwd, "platform.config.yaml");
  let raw = DEFAULT_YAML;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    await writeFile(path, DEFAULT_YAML, "utf8");
  }

  const parsed = parseYaml(expandEnv(raw)) as Record<string, unknown>;
  const cfg = PlatformConfigSchema.parse(parsed);

  // Env overrides
  if (process.env.GITHUB_TOKEN) cfg.github.token = process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    cfg.github.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  }
  if (process.env.PLATFORM_TOKEN) cfg.platformToken = process.env.PLATFORM_TOKEN;
  if (process.env.PLATFORM_PORT) {
    cfg.listen.port = Number(process.env.PLATFORM_PORT);
  }

  cfg.dataDir = resolve(cwd, cfg.dataDir);
  cfg.reposCache = resolve(cwd, cfg.reposCache);
  if (cfg.webDist) cfg.webDist = resolve(cwd, cfg.webDist);
  cfg.codeloopBin = absolutizeCodeloopBin(cfg.codeloopBin, cwd);

  await mkdir(cfg.dataDir, { recursive: true });
  await mkdir(cfg.reposCache, { recursive: true });
  return cfg;
}

export function resolveCodeloopArgv(bin: string | string[]): string[] {
  if (Array.isArray(bin)) return bin;
  // "node path/to/cli.js" or bare "codeloop"
  if (bin.includes(" ")) return bin.split(/\s+/);
  return [bin];
}

/** Resolve relative script paths against platform cwd (not task worktree). */
function absolutizeCodeloopBin(bin: string | string[], cwd: string): string[] {
  const parts = resolveCodeloopArgv(bin);
  return parts.map((p, i) => {
    if (i === 0 && (p === "node" || p === "codeloop" || p.startsWith("/"))) return p;
    if (p.startsWith("/")) return p;
    if (p.endsWith(".js") || p.endsWith(".mjs") || p.includes("/")) return resolve(cwd, p);
    return p;
  });
}
