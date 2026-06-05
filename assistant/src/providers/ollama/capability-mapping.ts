import type { DiscoveredModel } from "./api-client.js";

export const CONTEXT_CLAMP_MAX = 131072;
export const CONTEXT_FALLBACK = 32768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type CatalogModelRow = {
  id: string;
  displayName: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  defaultContextWindowTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsToolUse: boolean;
  supportsCaching: false;
  longContextMode: "native-model";
  pricing: { inputPer1mTokens: 0; outputPer1mTokens: 0 };
};

export type AutoProfileDefaults = {
  provider: "ollama";
  provider_connection: string;
  model: string;
  label: string;
  description: string;
  source: "auto-ollama";
  effort: "high";
  maxTokens: number;
  thinking: { enabled: boolean; streamThinking: boolean };
  contextWindow: { maxInputTokens: number };
};

function clampedContext(reported: number | null): number {
  if (reported === null) return CONTEXT_FALLBACK;
  return Math.min(reported, CONTEXT_CLAMP_MAX);
}

export function toCatalogModel(model: DiscoveredModel): CatalogModelRow {
  const ctx = clampedContext(model.contextLength);
  const caps = new Set(model.capabilities);
  return {
    id: model.tag,
    displayName: model.tag,
    contextWindowTokens: ctx,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    defaultContextWindowTokens: ctx,
    supportsThinking: caps.has("thinking"),
    supportsVision: caps.has("vision"),
    supportsToolUse: caps.has("tools"),
    supportsCaching: false,
    longContextMode: "native-model",
    pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
  };
}

export function toProfileDefaults(
  model: DiscoveredModel,
  connectionName: string,
): AutoProfileDefaults {
  const caps = model.capabilities.filter((c) => c !== "completion");
  const sizePart = model.parameterSize;
  const capsPart = caps.length > 0 ? caps.join("/") : "";
  const descriptionParts = [sizePart, capsPart].filter(
    (p) => p && p.length > 0,
  );
  const description =
    descriptionParts.length > 0
      ? `Auto-discovered: ${descriptionParts.join(", ")}`
      : "Auto-discovered Ollama model";
  const thinkingEnabled = model.capabilities.includes("thinking");
  return {
    provider: "ollama",
    provider_connection: connectionName,
    model: model.tag,
    label: model.tag,
    description,
    source: "auto-ollama",
    effort: "high",
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    thinking: { enabled: thinkingEnabled, streamThinking: thinkingEnabled },
    contextWindow: { maxInputTokens: clampedContext(model.contextLength) },
  };
}
