import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

export class RepoManager {
  constructor(
    private readonly cacheRoot: string,
    private readonly githubToken?: string,
  ) {}

  clonePathFor(fullName: string): string {
    return join(this.cacheRoot, fullName.replace("/", "__"));
  }

  async ensureRepo(fullName: string, clonePath?: string, token?: string): Promise<string> {
    const path = clonePath ?? this.clonePathFor(fullName);
    await mkdir(this.cacheRoot, { recursive: true });
    const authToken = token ?? this.githubToken;

    try {
      await access(join(path, ".git"));
      try {
        await git(path, ["fetch", "--all", "--prune"], authToken);
      } catch {
        // local-only repo without usable remote — ok
      }
      return path;
    } catch {
      // need clone
    }

    await mkdir(join(path, ".."), { recursive: true });
    // Use http.extraHeader so the PAT is not written into remote URL / .git/config.
    await git(
      this.cacheRoot,
      ["clone", `https://github.com/${fullName}.git`, path],
      authToken,
    );
    return path;
  }

  async pushBranch(
    clonePath: string,
    branch: string,
    token?: string,
  ): Promise<void> {
    const authToken = token ?? this.githubToken;
    const fullName = await remoteFullName(clonePath);
    if (authToken) {
      await git(
        clonePath,
        [
          "push",
          `https://github.com/${fullName}.git`,
          `HEAD:refs/heads/${branch}`,
          "--force-with-lease",
        ],
        authToken,
      );
    } else {
      await git(clonePath, ["push", "-u", "origin", branch]);
    }
  }

  async currentDefaultBranch(clonePath: string, fallback: string): Promise<string> {
    try {
      const out = await git(clonePath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const m = /origin\/(.+)$/.exec(out.trim());
      if (m) return m[1]!;
    } catch {
      // fall through
    }
    return fallback;
  }
}

async function remoteFullName(clonePath: string): Promise<string> {
  const url = (await git(clonePath, ["remote", "get-url", "origin"])).trim();
  const m = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`cannot parse github remote: ${url}`);
  return m[1]!;
}

function git(cwd: string, args: string[], token?: string): Promise<string> {
  const finalArgs =
    token != null && token !== ""
      ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args]
      : args;
  return new Promise((resolve, reject) => {
    const child = spawn("git", finalArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      // Redact token if it somehow appears in error output from argv echoing.
      const scrub = (s: string) => (token ? s.split(token).join("***") : s);
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${scrub(stderr || stdout)}`));
      } else resolve(stdout);
    });
    child.on("error", reject);
  });
}
