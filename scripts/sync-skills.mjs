import { syncSkills } from "../packages/kernel/dist/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const results = syncSkills({ sourceDir: join(root, "skills"), projectDir: root });
  for (const r of results) {
    console.log(`synced ${join(root, r.target)} (${r.skills.join(", ")})`);
  }
} catch (err) {
  console.error(
    err instanceof Error ? err.message : err,
    "\nIs @devtools/kernel built? Run `pnpm build` first.",
  );
  process.exit(1);
}
