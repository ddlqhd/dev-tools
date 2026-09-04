import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePlatformPaths,
  loadPlatformConfig,
  resolveCodeloopArgv,
} from "../src/config.js";

let tmp: string;

async function freshDir(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "codeloop-plat-"));
  return tmp;
}

async function cleanup(): Promise<void> {
  await rm(tmp, { recursive: true, force: true });
}

test("resolveCodeloopArgv: string with spaces vs single token vs array", () => {
  assert.deepEqual(resolveCodeloopArgv("node packages/cli/dist/index.js"), ["node", "packages/cli/dist/index.js"]);
  assert.deepEqual(resolveCodeloopArgv("codeloop"), ["codeloop"]);
  assert.deepEqual(resolveCodeloopArgv(["node", "/x/y.js"]), ["node", "/x/y.js"]);
});

test("loadPlatformConfig: writes defaults and applies defaults", async () => {
  const homeDir = await freshDir();
  try {
    const cfg = await loadPlatformConfig({ dataDir: homeDir, cwd: homeDir });
    assert.equal(cfg.listen.port, 4800);
    assert.equal(cfg.scheduler.globalMaxInstances, 2);
    assert.equal(cfg.scheduler.tickMs, 3000);
    assert.equal(cfg.scheduler.pollIntervalMs, 300_000);
    assert.equal(cfg.defaultBaseBranch, "main");
    assert.ok(Array.isArray(cfg.codeloopBin));
    assert.ok(cfg.dataDir.endsWith(homeDir), `dataDir=${cfg.dataDir}`);
  } finally {
    await cleanup();
  }
});

test("loadPlatformConfig: reads user yaml and resolves relative paths against home", async () => {
  const homeDir = await freshDir();
  try {
    await writeFile(
      join(homeDir, "platform.config.yaml"),
      "dataDir: data\nreposCache: data/repos\nlisten:\n  port: 9999\nscheduler:\n  globalMaxInstances: 5\ncodeloopBin: node ./cli.js\n",
      "utf8",
    );
    const cfg = await loadPlatformConfig({ cwd: homeDir });
    assert.equal(cfg.listen.port, 9999);
    assert.equal(cfg.scheduler.globalMaxInstances, 5);
    assert.equal(cfg.dataDir, join(homeDir, "data"));
    assert.equal(cfg.reposCache, join(homeDir, "data", "repos"));
    assert.deepEqual(cfg.codeloopBin, [process.execPath, join(homeDir, "cli.js")]);
  } finally {
    await cleanup();
  }
});

test("loadPlatformConfig: expands env vars in yaml", async () => {
  const homeDir = await freshDir();
  try {
    process.env.CODELOOP_TEST_TOKEN = "sekret";
    await writeFile(
      join(homeDir, "platform.config.yaml"),
      "github:\n  token: ${CODELOOP_TEST_TOKEN}\n",
      "utf8",
    );
    const cfg = await loadPlatformConfig({ dataDir: homeDir, cwd: homeDir });
    assert.equal(cfg.github.token, "sekret");
  } finally {
    delete process.env.CODELOOP_TEST_TOKEN;
    await cleanup();
  }
});

test("loadPlatformConfig: env overrides win", async () => {
  const homeDir = await freshDir();
  try {
    await writeFile(
      join(homeDir, "platform.config.yaml"),
      "github:\n  token: from-file\nlisten:\n  port: 1111\n",
      "utf8",
    );
    process.env.GITHUB_TOKEN = "from-env";
    process.env.PLATFORM_PORT = "7777";
    try {
      const cfg = await loadPlatformConfig({ dataDir: homeDir, cwd: homeDir });
      assert.equal(cfg.github.token, "from-env");
      assert.equal(cfg.listen.port, 7777);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.PLATFORM_PORT;
    }
  } finally {
    await cleanup();
  }
});

test("resolvePlatformPaths: explicit dataDir and configPath", async () => {
  const homeDir = await freshDir();
  try {
    const configPath = join(homeDir, "custom", "platform.config.yaml");
    await mkdir(join(homeDir, "custom"), { recursive: true });
    await writeFile(configPath, "dataDir: .platform\n", "utf8");
    const paths = await resolvePlatformPaths({ configPath, cwd: homeDir });
    assert.equal(paths.configPath, configPath);
    assert.equal(paths.homeDir, join(homeDir, "custom"));
  } finally {
    await cleanup();
  }
});

test("resolvePlatformPaths: CODELOOP_PLATFORM_HOME wins over cwd config", async () => {
  const homeDir = await freshDir();
  try {
    const envHome = join(homeDir, "env-home");
    await mkdir(envHome, { recursive: true });
    await writeFile(join(homeDir, "platform.config.yaml"), "listen:\n  port: 1\n", "utf8");
    process.env.CODELOOP_PLATFORM_HOME = envHome;
    try {
      const paths = await resolvePlatformPaths({ cwd: homeDir });
      assert.equal(paths.homeDir, envHome);
      assert.equal(paths.configPath, join(envHome, "platform.config.yaml"));
    } finally {
      delete process.env.CODELOOP_PLATFORM_HOME;
    }
  } finally {
    await cleanup();
  }
});

test("resolvePlatformPaths: walks up from subdirectory to ancestor config", async () => {
  const root = await freshDir();
  try {
    const nested = join(root, "packages", "platform-server");
    await mkdir(nested, { recursive: true });
    const configPath = join(root, "platform.config.yaml");
    await writeFile(configPath, "listen:\n  port: 4800\n", "utf8");
    const paths = await resolvePlatformPaths({ cwd: nested });
    assert.equal(paths.configPath, configPath);
    assert.equal(paths.homeDir, root);
  } finally {
    await cleanup();
  }
});

test("resolvePlatformPaths: does not walk past the git root", async () => {
  const outer = await freshDir();
  try {
    await writeFile(join(outer, "platform.config.yaml"), "listen:\n  port: 1\n", "utf8");
    const repo = join(outer, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo });
    const nested = join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    const dataDir = join(repo, ".platform");
    const paths = await resolvePlatformPaths({ cwd: nested, dataDir });
    assert.notEqual(paths.configPath, join(outer, "platform.config.yaml"));
    assert.equal(paths.homeDir, dataDir);
    assert.equal(paths.configPath, join(dataDir, "platform.config.yaml"));
  } finally {
    await cleanup();
  }
});

test("loadPlatformConfig: --data-dir does not hide ancestor config", async () => {
  const root = await freshDir();
  try {
    const nested = join(root, "packages", "platform-server");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, "platform.config.yaml"),
      "listen:\n  port: 4801\ncodeloopBin: node ./packages/cli/dist/index.js\n",
      "utf8",
    );
    const dataDir = join(root, ".platform");
    const cfg = await loadPlatformConfig({ cwd: nested, dataDir });
    assert.equal(cfg.listen.port, 4801);
    assert.equal(cfg.dataDir, dataDir);
    assert.deepEqual(cfg.codeloopBin, [
      process.execPath,
      join(root, "packages/cli/dist/index.js"),
    ]);
  } finally {
    await cleanup();
  }
});

test("loadPlatformConfig: rejects invalid config", async () => {
  const homeDir = await freshDir();
  try {
    await writeFile(join(homeDir, "platform.config.yaml"), "listen:\n  port: nope\n", "utf8");
    await assert.rejects(() => loadPlatformConfig({ dataDir: homeDir, cwd: homeDir }));
  } finally {
    await cleanup();
  }
});
