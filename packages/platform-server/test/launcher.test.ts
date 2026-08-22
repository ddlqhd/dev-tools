import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessLauncher, serveExitError } from "../src/launcher/local.js";

test("serveExitError includes clipped process output", () => {
  assert.equal(serveExitError(1, ""), "codeloop serve exited early with code 1");
  assert.match(
    serveExitError(1, "Cannot find package 'commander'\nimported from cli"),
    /code 1 — Cannot find package 'commander' imported from cli/,
  );
  const long = "x".repeat(1200);
  const msg = serveExitError(1, long);
  assert.match(msg, /code 1 — x{800}…$/);
});

test("launch includes stderr when serve exits immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeloop-launch-"));
  try {
    const script = join(dir, "fail-serve.mjs");
    await writeFile(
      script,
      "console.error(\"Cannot find package 'commander'\");\nprocess.exit(1);\n",
      "utf8",
    );
    const launcher = new LocalProcessLauncher([process.execPath, script]);
    await assert.rejects(
      launcher.launch({ repoPath: dir }),
      /exited early with code 1 — Cannot find package 'commander'/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch waits for /health then terminate stops the process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeloop-launch-ok-"));
  try {
    const script = join(dir, "ok-serve.mjs");
    await writeFile(
      script,
      `
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((req, res) => {
  if ((req.url ?? "").split("?")[0] === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
`,
      "utf8",
    );
    const launcher = new LocalProcessLauncher([process.execPath, script]);
    const handle = await launcher.launch({ repoPath: dir });
    try {
      assert.equal(await launcher.probe(handle), "alive");
      assert.match(handle.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await launcher.terminate(handle);
    }
    assert.equal(await launcher.probe(handle), "dead");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
