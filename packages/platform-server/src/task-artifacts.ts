import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactFile } from "@devtools/shared";

const ARTIFACT_EXTS = ["md", "json", "txt"] as const;

/** Same allow-list the kernel uses for `/tasks/:id/artifacts/:id`. */
export function isSafeArtifactId(id: string): boolean {
  return /^[\w.-]+$/.test(id);
}

function artifactsDir(repoPath: string, kernelTaskId: string): string {
  return join(repoPath, ".codeloop", "tasks", kernelTaskId, "artifacts");
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** List deliverables that survive after the kernel instance is gone. */
export async function listTaskArtifacts(
  repoPath: string | undefined,
  kernelTaskId: string | null,
): Promise<ArtifactFile[]> {
  if (!repoPath || !kernelTaskId || !isSafeArtifactId(kernelTaskId)) return [];
  const dir = artifactsDir(repoPath, kernelTaskId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: ArtifactFile[] = [];
  for (const name of names.sort()) {
    const ext = extname(name).replace(/^\./, "");
    if (!ext) continue;
    const candidate = resolve(dir, name);
    if (!isPathInside(resolve(dir), candidate)) continue;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      files.push({
        key: name.slice(0, name.length - ext.length - 1),
        ext,
        size: info.size,
        mtime: info.mtime.toISOString(),
        path: candidate,
      });
    } catch {
      // disappeared mid-listing
    }
  }
  return files;
}

export async function readTaskArtifact(
  repoPath: string,
  kernelTaskId: string,
  artifactId: string,
): Promise<{ contentType: string; body: string } | null> {
  if (!isSafeArtifactId(kernelTaskId) || !isSafeArtifactId(artifactId)) return null;
  const base = resolve(artifactsDir(repoPath, kernelTaskId));
  for (const ext of ARTIFACT_EXTS) {
    const candidate = resolve(base, `${artifactId}.${ext}`);
    if (!isPathInside(base, candidate)) return null;
    try {
      const body = await readFile(candidate, "utf8");
      return {
        contentType: ext === "json" ? "application/json" : "text/plain; charset=utf-8",
        body,
      };
    } catch {
      // try next extension
    }
  }
  return null;
}
