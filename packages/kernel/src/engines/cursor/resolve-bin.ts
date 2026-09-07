import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import which, { whichAll } from "../which.js";

export interface CursorBinResolution {
  binary: string | null;
  grokCollision?: string;
  reason?: string;
}

export interface SpawnTarget {
  command: string;
  prefix: string[];
}

/**
 * Locate the real Cursor Agent CLI.
 *
 * `agent` is the historical name, but Grok's CLI also ships as `agent` and
 * steals `-p` (`--single <PROMPT>`). Prefer `cursor-agent`, skip Grok paths,
 * and fall back to the well-known Windows install directory.
 */
export async function resolveCursorBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CursorBinResolution> {
  const override = env.CODELOOP_CURSOR_BIN?.trim();
  if (override) {
    const found = await resolveOverride(override, env);
    if (!found) {
      return { binary: null, reason: `CODELOOP_CURSOR_BIN not found: ${override}` };
    }
    if (isGrokCli(found)) {
      return {
        binary: null,
        grokCollision: found,
        reason: `CODELOOP_CURSOR_BIN points to Grok CLI (${found}), not Cursor Agent`,
      };
    }
    return { binary: found };
  }

  const candidates: string[] = [];
  for (const name of ["cursor-agent", "agent"]) {
    candidates.push(...(await whichAll(name, env)));
  }
  for (const known of wellKnownCursorBins(env)) {
    if (existsSync(known)) candidates.push(known);
  }

  const grokCollision = candidates.find(isGrokCli);
  const cursor = candidates.find((p) => !isGrokCli(p));
  if (cursor) return { binary: cursor, grokCollision };
  if (grokCollision) {
    return {
      binary: null,
      grokCollision,
      reason:
        `PATH's 'agent' is Grok CLI (${grokCollision}), not Cursor Agent. ` +
        "Install Cursor CLI or set CODELOOP_CURSOR_BIN to cursor-agent.",
    };
  }
  return { binary: null, reason: "Command 'cursor-agent' / 'agent' not found in PATH" };
}

/** Grok installs `agent` under `~/.grok/bin`, colliding with Cursor's CLI name. */
export function isGrokCli(binary: string): boolean {
  const n = binary.replace(/\\/g, "/").toLowerCase();
  if (n.includes("/.grok/")) return true;
  return /(^|\/)grok(\.exe)?$/.test(n);
}

export function looksLikeGrokCliOutput(text: string): boolean {
  return /Grok Build TUI|--single <PROMPT>/i.test(text);
}

/**
 * Turn a Windows `.cmd`/`.ps1` Cursor shim into `node.exe index.js` so we can
 * spawn without a shell (prompts contain quotes and would break `cmd /c`).
 */
export function spawnTarget(binary: string): SpawnTarget {
  const unwrapped = unwrapCursorInstall(binary);
  if (unwrapped) return unwrapped;

  if (process.platform === "win32") {
    if (/\.ps1$/i.test(binary)) return powershellFile(binary);
    if (/\.(cmd|bat)$/i.test(binary)) {
      const ps1 = binary.replace(/\.(cmd|bat)$/i, ".ps1");
      if (existsSync(ps1)) return powershellFile(ps1);
    }
  }

  if (/\.m?js$/i.test(binary)) {
    return { command: process.execPath, prefix: [binary] };
  }

  return { command: binary, prefix: [] };
}

export function invokedAsEnv(binary: string): Record<string, string> {
  if (!/\.(cmd|bat|ps1)$/i.test(binary)) return {};
  return { CURSOR_INVOKED_AS: basename(binary) };
}

function wellKnownCursorBins(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local) {
      out.push(join(local, "cursor-agent", "cursor-agent.cmd"));
      out.push(join(local, "cursor-agent", "agent.cmd"));
    }
  } else {
    const home = env.HOME ?? homedir();
    out.push(join(home, ".local", "bin", "cursor-agent"));
    out.push(join(home, ".local", "bin", "agent"));
  }
  return out;
}

async function resolveOverride(
  override: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const found = await which(override, env);
  if (found) return found;
  if (existsSync(override)) return override;
  if (process.platform === "win32") {
    for (const ext of [".cmd", ".exe", ".bat", ".ps1"]) {
      if (existsSync(override + ext)) return override + ext;
    }
  }
  return null;
}

function unwrapCursorInstall(binary: string): SpawnTarget | null {
  const dir = dirname(binary);
  const direct = nodeEntryPair(dir);
  if (direct) return direct;
  const latest = latestVersionDir(join(dir, "versions"));
  if (latest) return nodeEntryPair(latest);
  return null;
}

function nodeEntryPair(dir: string): SpawnTarget | null {
  const node = join(dir, "node.exe");
  const entry = join(dir, "index.js");
  if (existsSync(node) && existsSync(entry)) {
    return { command: node, prefix: [entry] };
  }
  return null;
}

function latestVersionDir(versionsDir: string): string | null {
  if (!existsSync(versionsDir)) return null;
  let best: { path: string; key: number; name: string } | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(versionsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d{4}\.\d{1,2}\.\d{1,2}-/.test(name)) continue;
    const path = join(versionsDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const key = versionSortKey(name);
    if (!best || key > best.key || (key === best.key && name > best.name)) {
      best = { path, key, name };
    }
  }
  return best?.path ?? null;
}

function versionSortKey(name: string): number {
  const datePart = name.split("-")[0] ?? "";
  const parts = datePart.split(".");
  if (parts.length !== 3) return 0;
  return Number(parts[0] + parts[1].padStart(2, "0") + parts[2].padStart(2, "0")) || 0;
}

function powershellFile(ps1: string): SpawnTarget {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return {
    command: join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
  };
}
