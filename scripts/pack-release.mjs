#!/usr/bin/env node
/**
 * Build a single fat tarball @devtools/codeloop with bins:
 *   codeloop, codeloop-platform
 *
 * Vendors @devtools/kernel + @devtools/shared via bundleDependencies so
 * `npm pack` includes them (must live under staging/node_modules).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function collectRuntimeDeps(...pkgPaths) {
  const deps = {};
  for (const p of pkgPaths) {
    const pkg = readJson(p);
    for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@devtools/")) continue;
      // Prefer first seen; versions across packages should be compatible
      if (!deps[name]) deps[name] = ver;
    }
  }
  return deps;
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`);
    process.exit(1);
  }
}

// 1. Sync version
run(process.execPath, ["scripts/sync-version.mjs"]);
const version = readFileSync(join(root, "VERSION"), "utf8").trim();

// 2. Build all packages (web before server so copy-assets succeeds)
run("pnpm", ["--filter", "@devtools/shared", "run", "build"]);
run("pnpm", ["--filter", "@devtools/kernel", "run", "build"]);
run("pnpm", ["--filter", "@devtools/cli", "run", "build"]);
run("pnpm", ["--filter", "@devtools/platform-web", "run", "build"]);
run("pnpm", ["--filter", "@devtools/platform-server", "run", "build"]);

const cliDist = join(root, "packages/cli/dist");
const serverDist = join(root, "packages/platform-server/dist");
const kernelDist = join(root, "packages/kernel/dist");
const sharedDist = join(root, "packages/shared/dist");

assertExists(join(cliDist, "index.js"), "cli dist");
assertExists(join(serverDist, "cli.js"), "platform-server dist");
assertExists(join(serverDist, "web/index.html"), "embedded web");
assertExists(join(kernelDist, "pipelines"), "kernel pipelines");
assertExists(join(sharedDist, "index.js"), "shared dist");

// 3. Staging layout
const staging = join(root, "release/staging");
const artifacts = join(root, "release/artifacts");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(artifacts, { recursive: true });

cpSync(cliDist, join(staging, "dist/cli"), { recursive: true });
cpSync(serverDist, join(staging, "dist/platform"), { recursive: true });

// Vendor @devtools/kernel
const kernelNm = join(staging, "node_modules/@devtools/kernel");
mkdirSync(kernelNm, { recursive: true });
cpSync(kernelDist, join(kernelNm, "dist"), { recursive: true });
// Vendored package.json must NOT declare third-party deps: npm would create
// empty placeholder dirs that shadow the real packages installed on the fat
// package. Resolution walks up to @devtools/codeloop/node_modules instead.
writeJson(join(kernelNm, "package.json"), {
  name: "@devtools/kernel",
  version,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  },
});

// Vendor @devtools/shared
const sharedNm = join(staging, "node_modules/@devtools/shared");
mkdirSync(sharedNm, { recursive: true });
cpSync(sharedDist, join(sharedNm, "dist"), { recursive: true });
writeJson(join(sharedNm, "package.json"), {
  name: "@devtools/shared",
  version,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  },
});

const runtimeDeps = collectRuntimeDeps(
  join(root, "packages/cli/package.json"),
  join(root, "packages/kernel/package.json"),
  join(root, "packages/shared/package.json"),
  join(root, "packages/platform-server/package.json"),
);

writeJson(join(staging, "package.json"), {
  name: "@devtools/codeloop",
  version,
  description: "codeloop — automated AI development loop + platform",
  type: "module",
  bin: {
    codeloop: "./dist/cli/index.js",
    "codeloop-platform": "./dist/platform/cli.js",
  },
  engines: { node: ">=22.13" },
  files: ["dist", "node_modules/@devtools"],
  dependencies: {
    "@devtools/kernel": version,
    "@devtools/shared": version,
    ...runtimeDeps,
  },
  bundleDependencies: ["@devtools/kernel", "@devtools/shared"],
});

// Ensure bin scripts are executable bits preserved; npm pack handles shebang
const cliBin = join(staging, "dist/cli/index.js");
const platBin = join(staging, "dist/platform/cli.js");
assertExists(cliBin, "staged cli bin");
assertExists(platBin, "staged platform bin");

// 4. npm pack from staging
console.log("packing…");
const pack = spawnSync(
  "npm",
  ["pack", "--pack-destination", artifacts],
  { cwd: staging, encoding: "utf8" },
);
if (pack.status !== 0) {
  console.error(pack.stdout);
  console.error(pack.stderr);
  process.exit(pack.status ?? 1);
}
const tgzName = (pack.stdout || "").trim().split("\n").filter(Boolean).pop();
if (!tgzName) {
  console.error("npm pack produced no tarball name");
  process.exit(1);
}
const tgzPath = join(artifacts, tgzName);
assertExists(tgzPath, "packed tarball");
console.log(`packed → ${tgzPath}`);

// 5. Validate contents
const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
const required = [
  "package/dist/cli/index.js",
  "package/dist/platform/cli.js",
  "package/dist/platform/web/index.html",
  "package/node_modules/@devtools/kernel/dist/index.js",
  "package/node_modules/@devtools/shared/dist/index.js",
];
const pipelineYaml = listing
  .split("\n")
  .filter((l) => l.includes("node_modules/@devtools/kernel/dist/pipelines/") && l.endsWith(".yaml"));
if (pipelineYaml.length === 0) {
  console.error("tarball missing kernel pipeline yaml files");
  process.exit(1);
}
for (const need of required) {
  if (!listing.split("\n").includes(need) && !listing.includes(need)) {
    // tar may or may not have trailing slash variants; use includes
    const found = listing.split("\n").some((l) => l === need || l === `${need}/`);
    if (!found) {
      console.error(`tarball missing required path: ${need}`);
      process.exit(1);
    }
  }
}
console.log(`validated tarball (${pipelineYaml.length} pipeline yaml files)`);
console.log(`\nInstall:\n  npm i -g ${tgzPath}\n  codeloop doctor\n  codeloop-platform\n`);
