import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Minimal which() without external deps. Honors PATHEXT on Windows. */
export default async function which(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const all = await whichAll(cmd, env);
  return all[0] ?? null;
}

/** Every PATH match for `cmd`, in PATH order (Windows includes PATHEXT variants). */
export async function whichAll(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (cmd.includes("/") || cmd.includes("\\")) {
    if (await isFile(cmd)) return [cmd];
    if (process.platform === "win32" && !hasPathext(cmd, env)) {
      for (const ext of pathext(env)) {
        if (await isFile(cmd + ext)) return [cmd + ext];
      }
    }
    return [];
  }

  const pathEnv = env.PATH ?? "";
  const suffixes = nameSuffixes(cmd, env);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, cmd + suffix);
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      if (await isFile(candidate)) {
        seen.add(key);
        found.push(candidate);
      }
    }
  }
  return found;
}

function nameSuffixes(cmd: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [""];
  if (hasPathext(cmd, env)) return [""];
  return ["", ...pathext(env)];
}

function pathext(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return raw.split(";").filter(Boolean).map((ext) => ext.toLowerCase());
}

function hasPathext(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const lower = cmd.toLowerCase();
  return pathext(env).some((ext) => lower.endsWith(ext.toLowerCase()));
}

async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
