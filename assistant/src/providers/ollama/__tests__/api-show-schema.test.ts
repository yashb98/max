import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "api-show");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

/**
 * Capabilities Ollama emits for models we know how to handle. The discovery
 * service routes vision/tools/thinking models into the picker. "embedding"
 * shows up for embedding-only models (e.g. bge-m3); they're a separate
 * surface and must NOT be promoted to chat profiles — track them here so
 * a future drift warning surfaces if/when we want to filter them out.
 */
const KNOWN_CAPS = new Set([
  "completion",
  "vision",
  "tools",
  "thinking",
  "embedding",
]);

const PARAM_SIZE_RE = /^\d+(\.\d+)?[BMK]$/;

type ShowFixture = {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { parameter_size?: string };
};

function assertShape(payload: ShowFixture, label: string) {
  expect(Array.isArray(payload.capabilities)).toBe(true);
  for (const cap of payload.capabilities!) {
    if (!KNOWN_CAPS.has(cap)) {
      throw new Error(
        `${label}: unknown capability ${JSON.stringify(cap)} — extend KNOWN_CAPS or filter`,
      );
    }
  }

  // Embedding-only models lack chat capabilities; skip the context-length
  // check because their model_info may not always carry one and we don't
  // surface them as profiles anyway.
  const isEmbeddingOnly =
    payload.capabilities!.length === 1 && payload.capabilities![0] === "embedding";

  if (!isEmbeddingOnly) {
    expect(payload.model_info).toBeDefined();
    const ctxKey = Object.keys(payload.model_info!).find(
      (k) => k.endsWith(".context_length") && typeof payload.model_info![k] === "number",
    );
    if (!ctxKey) {
      throw new Error(
        `${label}: no *.context_length numeric key in model_info — got keys ${JSON.stringify(Object.keys(payload.model_info!))}`,
      );
    }
  }

  const size = payload.details?.parameter_size;
  if (size && !PARAM_SIZE_RE.test(size)) {
    throw new Error(
      `${label}: parameter_size ${JSON.stringify(size)} does not match ${PARAM_SIZE_RE}`,
    );
  }
}

describe("api-show schema canary", () => {
  test("captured fixtures satisfy the expected schema", () => {
    expect(existsSync(FIXTURE_DIR)).toBe(true);
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const data = JSON.parse(
        readFileSync(join(FIXTURE_DIR, f), "utf-8"),
      ) as ShowFixture;
      assertShape(data, f);
    }
  });

  test.skipIf(!process.env.RUN_LIVE_OLLAMA)(
    "live Ollama satisfies the expected schema",
    async () => {
      const tagsRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      expect(tagsRes.ok).toBe(true);
      const tags = (await tagsRes.json()) as { models: { name: string }[] };
      expect(tags.models.length).toBeGreaterThan(0);

      // Hit the first 3 models (or all if fewer) — keep the live probe cheap.
      const sample = tags.models.slice(0, 3);
      for (const m of sample) {
        const showRes = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: m.name }),
        });
        expect(showRes.ok).toBe(true);
        const show = (await showRes.json()) as ShowFixture;
        assertShape(show, `live:${m.name}`);
      }
    },
  );
});
