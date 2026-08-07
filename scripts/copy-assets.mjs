import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.argv[2];

if (pkg === "kernel") {
  const src = join(root, "packages/kernel/src/pipelines");
  const dest = join(root, "packages/kernel/dist/pipelines");
  if (!existsSync(src)) {
    console.error("pipelines source missing:", src);
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log("copied pipelines →", dest);
} else if (pkg === "platform-server") {
  const src = join(root, "packages/platform-web/dist");
  const dest = join(root, "packages/platform-server/dist/web");
  if (!existsSync(src)) {
    console.warn("skip web copy — platform-web dist missing (run platform:build or pack:release):", src);
    process.exit(0);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log("copied platform-web →", dest);
} else {
  console.error("usage: node scripts/copy-assets.mjs <kernel|platform-server>");
  process.exit(1);
}
