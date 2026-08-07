#!/usr/bin/env node
import { resolve } from "node:path";
import { loadPlatformConfig } from "./config.js";
import { startPlatformServer } from "./app.js";

function parseArgs(argv: string[]): { config?: string; dataDir?: string } {
  const out: { config?: string; dataDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "-c") {
      out.config = argv[++i];
    } else if (a.startsWith("--config=")) {
      out.config = a.slice("--config=".length);
    } else if (a === "--data-dir") {
      out.dataDir = argv[++i];
    } else if (a.startsWith("--data-dir=")) {
      out.dataDir = a.slice("--data-dir=".length);
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: codeloop-platform [options]

Options:
  -c, --config <path>   Path to platform.config.yaml
      --data-dir <path> Override data directory
  -h, --help            Show help
`);
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadPlatformConfig({
    cwd: process.cwd(),
    configPath: args.config ? resolve(process.cwd(), args.config) : undefined,
    dataDir: args.dataDir,
  });
  const app = await startPlatformServer(config);
  console.log(
    `codeloop-platform listening on http://${config.listen.host}:${config.listen.port}`,
  );
  console.log(`dataDir: ${config.dataDir}`);
  console.log(`reposCache: ${config.reposCache}`);
  console.log(`codeloopBin: ${config.codeloopBin.join(" ")}`);

  const shutdown = async () => {
    console.log("\nShutting down platform…");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
