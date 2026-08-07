import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Minimal which() without external deps. */
export default async function which(cmd: string): Promise<string | null> {
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      await access(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}
