import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import which, { whichAll } from "../src/engines/which.js";
import {
  isGrokCli,
  looksLikeGrokCliOutput,
  resolveCursorBinary,
  spawnTarget,
} from "../src/engines/cursor/resolve-bin.js";

function fakeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ...overrides,
  };
}

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codeloop-which-"));
}

async function touchCmd(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

test("which: finds a PATHEXT/.cmd (Windows) or bare name (Unix)", async (t) => {
  const dir = await makeDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const name = process.platform === "win32" ? "mycmd.cmd" : "mycmd";
  const expected = await touchCmd(dir, name);
  const found = await which("mycmd", fakeEnv({ PATH: dir }));
  assert.equal(found, expected);
});

test("whichAll: PATH order, grok agent.exe before later matches", async (t) => {
  const grok = await makeDir();
  const later = await makeDir();
  t.after(async () => {
    await rm(grok, { recursive: true, force: true });
    await rm(later, { recursive: true, force: true });
  });
  const grokName = process.platform === "win32" ? "agent.exe" : "agent";
  const laterName = process.platform === "win32" ? "agent.cmd" : "agent";
  const grokBin = await touchCmd(grok, grokName);
  const laterBin = await touchCmd(later, laterName);
  const all = await whichAll("agent", fakeEnv({ PATH: `${grok}${delimiter}${later}` }));
  assert.equal(all[0], grokBin);
  if (process.platform === "win32") {
    assert.ok(all.includes(laterBin));
  }
});

test("isGrokCli: .grok/bin and grok.exe, not cursor-agent", () => {
  assert.equal(isGrokCli("C:/Users/me/.grok/bin/agent.exe"), true);
  assert.equal(isGrokCli("/home/me/.grok/bin/agent"), true);
  assert.equal(isGrokCli("/usr/bin/grok"), true);
  assert.equal(isGrokCli("C:/Users/me/AppData/Local/cursor-agent/cursor-agent.cmd"), false);
  assert.equal(looksLikeGrokCliOutput("Grok Build TUI\n  -p, --single <PROMPT>"), true);
  assert.equal(looksLikeGrokCliOutput("Usage: agent --print"), false);
});

test("resolveCursorBinary: prefers cursor-agent over Grok's agent", async (t) => {
  const home = await makeDir();
  const grokDir = join(home, ".grok", "bin");
  const cursorDir = join(home, "cursor-shim");
  await mkdir(grokDir, { recursive: true });
  await mkdir(cursorDir, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));

  const grokName = process.platform === "win32" ? "agent.exe" : "agent";
  const cursorName = process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
  const grokBin = await touchCmd(grokDir, grokName);
  const cursorBin = await touchCmd(cursorDir, cursorName);

  const resolved = await resolveCursorBinary(
    fakeEnv({
      PATH: `${grokDir}${delimiter}${cursorDir}`,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: home,
    }),
  );
  assert.equal(resolved.binary, cursorBin);
  assert.equal(resolved.grokCollision, grokBin);
});

test("resolveCursorBinary: Grok-only PATH is a collision, not Cursor", async (t) => {
  const home = await makeDir();
  const grokDir = join(home, ".grok", "bin");
  await mkdir(grokDir, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const grokName = process.platform === "win32" ? "agent.exe" : "agent";
  const grokBin = await touchCmd(grokDir, grokName);

  const resolved = await resolveCursorBinary(
    fakeEnv({
      PATH: grokDir,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: home,
    }),
  );
  assert.equal(resolved.binary, null);
  assert.equal(resolved.grokCollision, grokBin);
  assert.match(resolved.reason ?? "", /Grok CLI/);
});

test("resolveCursorBinary: CODELOOP_CURSOR_BIN override wins", async (t) => {
  const dir = await makeDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = await touchCmd(dir, "stub-agent.mjs");
  const resolved = await resolveCursorBinary(fakeEnv({ CODELOOP_CURSOR_BIN: stub, PATH: "" }));
  assert.equal(resolved.binary, stub);
});

test("resolveCursorBinary: CODELOOP_CURSOR_BIN pointing at Grok is rejected", async (t) => {
  const home = await makeDir();
  const grokDir = join(home, ".grok", "bin");
  await mkdir(grokDir, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const grokBin = await touchCmd(grokDir, process.platform === "win32" ? "agent.exe" : "agent");
  const resolved = await resolveCursorBinary(fakeEnv({ CODELOOP_CURSOR_BIN: grokBin }));
  assert.equal(resolved.binary, null);
  assert.equal(resolved.grokCollision, grokBin);
});

test("spawnTarget: unwraps cursor-agent shim to node.exe + index.js", async (t) => {
  const root = await makeDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ver = join(root, "versions", "2026.08.01-aaaaaa");
  await mkdir(ver, { recursive: true });
  const node = join(ver, "node.exe");
  const entry = join(ver, "index.js");
  await writeFile(node, "", "utf8");
  await writeFile(entry, "", "utf8");
  const shim = join(root, "cursor-agent.cmd");
  await writeFile(shim, "@echo off\n", "utf8");
  assert.deepEqual(spawnTarget(shim), { command: node, prefix: [entry] });
});

test("spawnTarget: .mjs stub is launched with the current node", () => {
  const stub = join("tmp", "stub-agent.mjs");
  assert.deepEqual(spawnTarget(stub), { command: process.execPath, prefix: [stub] });
});
