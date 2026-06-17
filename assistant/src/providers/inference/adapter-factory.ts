/**
 * Provider adapter construction.
 *
 * One catalog-keyed factory table feeds two construction paths:
 *
 *   - `buildProviderAdapter` returns a raw `Provider` instance for a given
 *     provider id + options. The caller wraps with `RetryProvider` /
 *     `UsageTrackingProvider` to match the boot-time vs per-connection
 *     wrapping conventions in `registry.ts`.
 *   - `createAdapterFromConnection` is the per-call dispatcher entry point.
 *     It resolves a `ResolvedAuth` into `AdapterCreateOpts`, validates
 *     keyless/keyed compatibility, and returns a fully-wrapped
 *     `Provider | null`.
 *
 * Adding a new provider:
 *   1. Add an entry to `PROVIDER_CATALOG` in `model-catalog.ts`.
 *   2. Implement the client in `src/providers/<id>/client.ts`.
 *   3. Register the client in `ADAPTER_FACTORIES` below.
 */

import { AnthropicProvider } from "../anthropic/client.js";
import { ClaudeSubscriptionProvider } from "../claude-subscription/client.js";
import { FireworksProvider } from "../fireworks/client.js";
import { GeminiProvider } from "../gemini/client.js";
import { KimiAgentProvider } from "../kimi-agent/client.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { OllamaProvider } from "../ollama/client.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../openai/responses-provider.js";
import { OpenRouterProvider } from "../openrouter/client.js";
import { RetryProvider } from "../retry.js";
import type { Provider } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";
import type { ResolvedAuth } from "./auth.js";
import type { ProviderConnection } from "./auth.js";

/** Unified construction opts. Adapters ignore fields they don't consume. */
export interface AdapterCreateOpts {
  apiKey: string;
  model: string;
  streamTimeoutMs: number;
  /** Set when an explicit base URL override or managed proxy is in play. */
  baseURL?: string;
  /** Forwarded to providers that wire native provider-side web search. */
  useNativeWebSearch: boolean;
}

type AdapterFactory = (opts: AdapterCreateOpts) => Provider;

/**
 * Catalog-keyed factory table. Each entry takes a unified
 * `AdapterCreateOpts` and constructs the underlying provider client. The
 * `id` field must match the corresponding `ProviderCatalogEntry.id` in
 * `PROVIDER_CATALOG` — `PROVIDER_CATALOG_FACTORY_PARITY` enforces this at
 * module-load time.
 */
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  anthropic: ({ apiKey, model, streamTimeoutMs, baseURL, useNativeWebSearch }) =>
    new AnthropicProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  // Claude via Max subscription. Auth comes from the locally installed
  // `claude` CLI (OAuth token in macOS Keychain), so the unified apiKey
  // slot is unused — `setupMode: "keyless"` in the catalog makes the
  // registry pass an empty string here.
  "claude-subscription": ({ model, streamTimeoutMs }) =>
    new ClaudeSubscriptionProvider(model, { streamTimeoutMs }),
  openai: ({ apiKey, model, streamTimeoutMs, baseURL, useNativeWebSearch }) =>
    new OpenAIResponsesProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  gemini: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new GeminiProvider(apiKey, model, {
      streamTimeoutMs,
      // Gemini routes managed proxies through `managedBaseUrl`, not `baseURL`.
      ...(baseURL ? { managedBaseUrl: baseURL } : {}),
    }),
  ollama: ({ apiKey, model, streamTimeoutMs }) =>
    new OllamaProvider(model, {
      // Empty string means keyless — Ollama's client treats undefined as
      // "no key provided" and defaults its internal placeholder.
      apiKey: apiKey || undefined,
      streamTimeoutMs,
    }),
  fireworks: ({ apiKey, model, streamTimeoutMs }) =>
    new FireworksProvider(apiKey, model, { streamTimeoutMs }),
  openrouter: ({ apiKey, model, streamTimeoutMs, useNativeWebSearch }) =>
    new OpenRouterProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
    }),
  // Kimi (Moonshot) — OpenAI-compatible chat completions API.
  // K2.6 rejects custom temperature/top_p/presence_penalty/frequency_penalty;
  // pin them to the documented fixed values so requests don't 4xx. Enable
  // reasoning round-trip so multi-turn tool-use conversations don't fail
  // with "thinking is enabled but reasoning_content is missing".
  kimi: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new OpenAIChatCompletionsProvider(apiKey, model, {
      providerName: "kimi",
      providerLabel: "Kimi",
      baseURL: baseURL ?? "https://api.moonshot.ai/v1",
      streamTimeoutMs,
      maxReasoningEffort: "high",
      supportsReasoningRoundTrip: true,
      extraCreateParams: {
        temperature: 1.0,
        top_p: 0.95,
        presence_penalty: 0.0,
        frequency_penalty: 0.0,
      },
    }),
  // Kimi via the Agent SDK — drives the kimi CLI as an in-process agentic
  // runtime. Tool calls bridge to Max's ToolExecutor via external tools.
  // Auth: MOONSHOT_API_KEY forwarded to the SDK env; falls back to the
  // user's ~/.kimi/config.toml login session when no key is provided.
  "kimi-agent": ({ apiKey, model, streamTimeoutMs }) =>
    new KimiAgentProvider(model, { streamTimeoutMs, apiKey }),
};

/**
 * Module-load parity guard. Surfaces a clear startup error if someone adds
 * a catalog entry without a matching factory (or vice versa).
 */
const PROVIDER_CATALOG_FACTORY_PARITY = (() => {
  const catalogIds = new Set(PROVIDER_CATALOG.map((entry) => entry.id));
  const factoryIds = new Set(Object.keys(ADAPTER_FACTORIES));
  const missingFactories = [...catalogIds].filter((id) => !factoryIds.has(id));
  const orphanFactories = [...factoryIds].filter((id) => !catalogIds.has(id));
  if (missingFactories.length > 0 || orphanFactories.length > 0) {
    const parts: string[] = [];
    if (missingFactories.length > 0) {
      parts.push(`missing adapter factories: ${missingFactories.join(", ")}`);
    }
    if (orphanFactories.length > 0) {
      parts.push(`orphan adapter factories: ${orphanFactories.join(", ")}`);
    }
    throw new Error(
      `PROVIDER_CATALOG / ADAPTER_FACTORIES drift: ${parts.join("; ")}`,
    );
  }
  return true;
})();

// Reference the parity guard so unused-variable lint doesn't strip it.
void PROVIDER_CATALOG_FACTORY_PARITY;

/**
 * Build a raw `Provider` instance from a provider id and unified opts.
 *
 * Returns null when no factory exists for the given provider id. The
 * caller is responsible for wrapping (RetryProvider, UsageTrackingProvider).
 */
export function buildProviderAdapter(
  providerId: string,
  opts: AdapterCreateOpts,
): Provider | null {
  const factory = ADAPTER_FACTORIES[providerId];
  if (!factory) return null;
  return factory(opts);
}

/**
 * Build a Provider instance for a given connection + resolved auth.
 *
 * Returns null when the provider/auth combination is not usable
 * (e.g. `none` auth on a keyed provider). The caller decides whether to
 * log a warning or fall back to the global registry.
 */
export function createAdapterFromConnection(
  connection: ProviderConnection,
  resolvedAuth: ResolvedAuth,
  opts: { model: string; streamTimeoutMs?: number; useNativeWebSearch?: boolean },
): Provider | null {
  const { provider } = connection;
  const entry = PROVIDER_CATALOG.find((e) => e.id === provider);
  if (!entry) return null;
  // Treat "cli-login" the same as "keyless" for credential plumbing —
  // both have no API key to pass; auth happens via a local side channel
  // (Ollama daemon / Claude Code OAuth in Keychain).
  const isKeyless =
    entry.setupMode === "keyless" || entry.setupMode === "cli-login";

  // Keyed providers can't operate without a credential.
  if (!isKeyless && resolvedAuth.kind === "none") return null;

  const apiKey =
    resolvedAuth.kind === "header"
      ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
      : "";
  const baseURL =
    resolvedAuth.kind === "header" ? resolvedAuth.baseUrl : undefined;

  const adapter = buildProviderAdapter(provider, {
    apiKey,
    model: opts.model,
    streamTimeoutMs: opts.streamTimeoutMs ?? 1_800_000,
    baseURL,
    useNativeWebSearch: opts.useNativeWebSearch ?? false,
  });
  if (!adapter) return null;

  const isProxy = baseURL !== undefined;
  return new UsageTrackingProvider(
    new RetryProvider(adapter, {
      forwardUsageAttributionHeaders: isProxy,
    }),
  );
}
