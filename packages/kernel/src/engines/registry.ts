import type { EngineAdapter, EngineType } from "./adapter.js";
import { CursorAdapter } from "./cursor/index.js";

const adapters: Partial<Record<EngineType, () => EngineAdapter>> = {
  cursor: () => new CursorAdapter(),
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
  throw new Error(`Unknown engine type: ${configType}`);
}
