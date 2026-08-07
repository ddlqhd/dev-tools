import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  PipelineDefinitionSchema,
  normalizeFlow,
  type FlowStep,
  type NodeSpec,
  type PipelineDefinition,
} from "@devtools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LoadedPipeline {
  definition: PipelineDefinition;
  flow: FlowStep[];
  nodes: Record<string, NodeSpec>;
  name: string;
  hash: string;
  rawYaml: string;
}

const BUILTIN_DIR = join(__dirname, "..", "pipelines");

export async function listBuiltinPipelines(): Promise<string[]> {
  try {
    const files = await readdir(BUILTIN_DIR);
    return files.filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
  } catch {
    return [];
  }
}

export async function loadPipeline(
  name: string,
  repoRoot: string,
): Promise<LoadedPipeline> {
  const customPath = join(repoRoot, ".codeloop", "pipelines", `${name}.yaml`);
  const builtinPath = join(BUILTIN_DIR, `${name}.yaml`);

  let rawYaml: string;
  try {
    rawYaml = await readFile(customPath, "utf8");
  } catch {
    try {
      rawYaml = await readFile(builtinPath, "utf8");
    } catch {
      throw new Error(`Pipeline not found: ${name}`);
    }
  }

  return parsePipelineYaml(rawYaml);
}

export function parsePipelineYaml(rawYaml: string): LoadedPipeline {
  const parsed = PipelineDefinitionSchema.parse(parseYaml(rawYaml));
  const flow = normalizeFlow(parsed.flow as unknown[]);
  validatePipeline(parsed, flow);
  const hash = createHash("sha256").update(rawYaml).digest("hex").slice(0, 16);
  return {
    definition: parsed,
    flow,
    nodes: parsed.nodes,
    name: parsed.pipeline,
    hash,
    rawYaml,
  };
}

function validatePipeline(def: PipelineDefinition, flow: FlowStep[]): void {
  const nodeIds = new Set(Object.keys(def.nodes));
  const loopIds = new Set<string>();

  for (const step of flow) {
    if (step.kind === "loop") {
      if (loopIds.has(step.id)) throw new Error(`Duplicate loop id: ${step.id}`);
      loopIds.add(step.id);
      if (!step.maxIterations || !step.until) {
        throw new Error(`Loop ${step.id} must declare maxIterations and until`);
      }
      for (const bodyNode of step.body) {
        if (!nodeIds.has(bodyNode)) throw new Error(`Unknown node in loop ${step.id}: ${bodyNode}`);
      }
    } else if (!nodeIds.has(step.nodeId)) {
      throw new Error(`Unknown node in flow: ${step.nodeId}`);
    }
  }

  for (const step of flow) {
    if (step.kind === "node" && step.onFail) {
      if (!loopIds.has(step.onFail.goto)) {
        throw new Error(`onFail.goto must reference a declared loop: ${step.onFail.goto}`);
      }
    }
  }

  // Artifact dependency: soft check that inputs exist as some outputs or are known seeds
  const produced = new Set<string>(["requirement"]);
  const visitNode = (nodeId: string) => {
    const node = def.nodes[nodeId];
    if (!node) return;
    for (const input of node.inputs ?? []) {
      if (!produced.has(input)) {
        // Allow forward refs within loops; warn via throw only for totally unknown
        // Soft: only ensure key looks intentional
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(input)) {
          throw new Error(`Invalid artifact key: ${input}`);
        }
      }
    }
    for (const output of node.outputs ?? []) produced.add(output);
  };

  for (const step of flow) {
    if (step.kind === "loop") {
      for (const id of step.body) visitNode(id);
    } else {
      visitNode(step.nodeId);
    }
  }
}

export async function snapshotPipeline(
  loaded: LoadedPipeline,
  taskDir: string,
): Promise<void> {
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "pipeline.snapshot.yaml"), loaded.rawYaml, "utf8");
}

export async function ensureBuiltinPipelinesCopied(destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const names = await listBuiltinPipelines();
  for (const name of names) {
    const src = join(BUILTIN_DIR, `${name}.yaml`);
    const dest = join(destDir, `${name}.yaml`);
    try {
      await copyFile(src, dest);
    } catch {
      // ignore if already exists or copy fails
    }
  }
}
