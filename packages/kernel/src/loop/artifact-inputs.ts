import {
  artifactExt,
  defaultArtifactInputs,
  type NodeSpec,
} from "@devtools/shared";
import type { ArtifactStore } from "../store/index.js";
import type { PromptContext } from "../prompts/index.js";

export type PromptArtifacts = Pick<
  PromptContext,
  "planDoc" | "planComments" | "reviewComments"
>;

/** Read declared (or default) artifact inputs; missing files stay undefined. */
export async function loadPromptArtifacts(
  spec: NodeSpec,
  artifacts: ArtifactStore,
): Promise<PromptArtifacts> {
  const keys = spec.inputs?.length ? spec.inputs : defaultArtifactInputs(spec);
  const loaded: Record<string, string | null> = {};
  for (const key of keys) {
    loaded[key] = await artifacts.readText(key, artifactExt(key));
  }
  return {
    planDoc: loaded.planDoc ?? undefined,
    planComments: loaded.planComments ?? undefined,
    reviewComments: loaded.reviewComments ?? undefined,
  };
}
