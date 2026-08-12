import type { EngineAdapter, EngineType } from "./adapter.js";
import { CursorAdapter } from "./cursor/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";

const adapters: Partial<Record<EngineType, () => EngineAdapter>> = {
  cursor: () => new CursorAdapter(),
  opencode: () => new OpenCodeAdapter(),
};

export function getEngineAdapter(type: EngineType): EngineAdapter {
  const factory = adapters[type];
  if (!factory) {
    throw new Error(`Engine adapter not implemented yet: ${type}`);
  }
  return factory();
}

export function resolveEngineType(configType: string): EngineType {
  if (configType === "cursor" || configType === "cursor-cli") return "cursor";
  if (configType === "claude-code" || configType === "claude") return "claude-code";
  if (configType === "codex") return "codex";
  if (configType === "opencode") return "opencode";
  throw new Error(`Unknown engine type: ${configType}`);
}
