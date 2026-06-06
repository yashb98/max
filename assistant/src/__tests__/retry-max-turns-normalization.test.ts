/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` plumbs the
 * per-profile `maxTurns` step budget only to the `kimi-agent` provider (the
 * sole consumer — its inner SDK-loop StepBegin guard) and strips it for every
 * other provider — so strict-schema wire clients (Anthropic, OpenAI, …) never
 * see the unknown field in a request body.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

function makePipeline(providerName: string): {
  provider: Provider;
  lastConfig: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const inner: Provider = {
    name: providerName,
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      captured = options?.config as Record<string, unknown> | undefined;
      return {
        content: [],
        model: "test",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
      };
    },
  };
  return {
    provider: new RetryProvider(inner),
    lastConfig: () => captured,
  };
}

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

describe("retry normalization for maxTurns (kimi-agent step budget)", () => {
  test("forwards a profile's maxTurns to kimi-agent via the call-site resolver", async () => {
    setLlmConfig({
      default: {
        provider: "kimi-agent",
        model: "kimi-k2.6-instant",
        maxTurns: 120,
      },
    });
    const { provider, lastConfig } = makePipeline("kimi-agent");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.maxTurns).toBe(120);
  });

  test("per-call explicit maxTurns wins over the resolved profile value", async () => {
    setLlmConfig({
      default: {
        provider: "kimi-agent",
        model: "kimi-k2.6-instant",
        maxTurns: 120,
      },
    });
    const { provider, lastConfig } = makePipeline("kimi-agent");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent", maxTurns: 33 },
    });
    expect(lastConfig()?.maxTurns).toBe(33);
  });

  test("strips maxTurns for anthropic (strict wire schema must not see it)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTurns: 120,
      },
    });
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.maxTurns).toBeUndefined();
  });

  test("strips a passthrough caller's maxTurns for non-kimi providers (no callSite)", async () => {
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { maxTurns: 50 },
    });
    expect(lastConfig()?.maxTurns).toBeUndefined();
  });

  test("profile without maxTurns → field absent for kimi-agent (mode preset decides)", async () => {
    setLlmConfig({
      default: { provider: "kimi-agent", model: "kimi-k2.6-instant" },
    });
    const { provider, lastConfig } = makePipeline("kimi-agent");
    await provider.sendMessage([userMessage], undefined, undefined, {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.maxTurns).toBeUndefined();
  });
});
