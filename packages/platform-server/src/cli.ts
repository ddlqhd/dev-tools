#!/usr/bin/env node
import { loadPlatformConfig } from "./config.js";
import { startPlatformServer } from "./app.js";

async function main(): Promise<void> {
  const config = await loadPlatformConfig(process.cwd());
  const app = await startPlatformServer(config);
  console.log(
    `platform-server listening on http://${config.listen.host}:${config.listen.port}`,
  );
  console.log(`dataDir: ${config.dataDir}`);
  console.log(`reposCache: ${config.reposCache}`);

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
