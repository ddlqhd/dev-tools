import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** argv for spawning codeloop; omit to auto-detect bundled / monorepo CLI */
  codeloopBin: z.union([z.string(), z.array(z.string())]).optional(),
  platformToken: z.string().optional(),
  consoleBaseUrl: z.string().optional(),
  defaultBaseBranch: z.string().default("main"),
  webDist: z.string().optional(),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema> & {
  /** Always resolved to absolute argv after load */
  codeloopBin: string[];
};

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
defaultBaseBranch: main
`;

export interface LoadPlatformConfigOptions {
  /** Explicit config file path (--config) */
  configPath?: string;
  /** Explicit data directory override (--data-dir) */
  dataDir?: string;
  /** Starting cwd for discovery (defaults to process.cwd()) */
  cwd?: string;
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

/** Resolve where platform home / config live for global vs monorepo use. */
export async function resolvePlatformPaths(opts: LoadPlatformConfigOptions = {}): Promise<{
  homeDir: string;
  configPath: string;
  createdDefault: boolean;
}> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.configPath) {
    const configPath = resolve(cwd, opts.configPath);
    const homeDir = opts.dataDir
      ? resolve(cwd, opts.dataDir)
      : dirname(configPath);
    return { homeDir, configPath, createdDefault: false };
  }

  if (opts.dataDir) {
    const homeDir = resolve(cwd, opts.dataDir);
    return {
      homeDir,
      configPath: join(homeDir, "platform.config.yaml"),
      createdDefault: false,
    };
  }

  if (process.env.CODELOOP_PLATFORM_HOME) {
    const homeDir = resolve(process.env.CODELOOP_PLATFORM_HOME);
    return {
      homeDir,
      configPath: join(homeDir, "platform.config.yaml"),
      createdDefault: false,
    };
  }

  const cwdConfig = join(cwd, "platform.config.yaml");
  try {
    await access(cwdConfig);
    return { homeDir: cwd, configPath: cwdConfig, createdDefault: false };
  } catch {
    // fall through
  }

  const homeDir = join(homedir(), ".codeloop-platform");
  return {
    homeDir,
    configPath: join(homeDir, "platform.config.yaml"),
    createdDefault: true,
  };
}

function detectDefaultCodeloopBin(baseDir: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // Released package layout: dist/platform/config.js → ../cli/index.js
  const bundledCli = resolve(here, "../cli/index.js");
  if (existsSync(bundledCli)) {
    return [process.execPath, bundledCli];
  }
  // Monorepo layout relative to platform home / cwd
  const monoCli = resolve(baseDir, "packages/cli/dist/index.js");
  if (existsSync(monoCli)) {
    return [process.execPath, monoCli];
  }
  // Last resort: PATH lookup
  return ["codeloop"];
}

export async function loadPlatformConfig(
  opts: LoadPlatformConfigOptions | string = {},
): Promise<PlatformConfig> {
  // Back-compat: loadPlatformConfig(cwd: string)
  const options: LoadPlatformConfigOptions =
    typeof opts === "string" ? { cwd: opts } : opts;

  const cwd = options.cwd ?? process.cwd();
  const { homeDir, configPath } = await resolvePlatformPaths(options);

  await mkdir(homeDir, { recursive: true });

  let raw = DEFAULT_YAML;
  let wroteDefault = false;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    await writeFile(configPath, DEFAULT_YAML, "utf8");
    wroteDefault = true;
  }
  if (wroteDefault) {
    console.log(`wrote default config → ${configPath}`);
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

  // Paths in config are relative to homeDir (where the config lives)
  if (options.dataDir) {
    cfg.dataDir = resolve(cwd, options.dataDir);
  } else {
    cfg.dataDir = resolve(homeDir, cfg.dataDir);
  }
  cfg.reposCache = resolve(homeDir, cfg.reposCache);
  if (cfg.webDist) cfg.webDist = resolve(homeDir, cfg.webDist);

  const explicitBin = cfg.codeloopBin;
  const resolved: PlatformConfig = {
    ...cfg,
    codeloopBin: explicitBin
      ? absolutizeCodeloopBin(explicitBin, homeDir)
      : detectDefaultCodeloopBin(homeDir),
  };

  await mkdir(resolved.dataDir, { recursive: true });
  await mkdir(resolved.reposCache, { recursive: true });
  return resolved;
}

export function resolveCodeloopArgv(bin: string | string[]): string[] {
  if (Array.isArray(bin)) return bin;
  if (bin.includes(" ")) return bin.split(/\s+/);
  return [bin];
}

/** Resolve relative script paths against platform home (not task worktree). */
function absolutizeCodeloopBin(bin: string | string[], baseDir: string): string[] {
  const parts = resolveCodeloopArgv(bin);
  return parts.map((p, i) => {
    if (i === 0 && (p === "node" || p === "codeloop" || p.startsWith("/"))) {
      return p === "node" ? process.execPath : p;
    }
    if (p.startsWith("/")) return p;
    if (p.endsWith(".js") || p.endsWith(".mjs") || p.includes("/")) return resolve(baseDir, p);
    return p;
  });
}
