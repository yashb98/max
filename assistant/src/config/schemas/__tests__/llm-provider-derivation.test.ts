import { describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../../../providers/model-catalog.js";
import { ProfileEntry } from "../llm.js";

/**
 * Regression: the `LLMProvider` zod enum used in profile validation must be
 * derived from `PROVIDER_CATALOG` so that adding a provider to the catalog
 * is a single edit. Previously the enum was hardcoded, and any provider
 * added to the catalog (e.g. a new BYOK provider) was silently rejected by
 * profile validation — surfacing in the macOS app as an unhelpful
 * "Couldn't save profile" toast.
 *
 * If this test fails after adding a provider to `PROVIDER_CATALOG`, the
 * derivation in `schemas/llm.ts` was broken.
 */
describe("LLMProvider schema derivation from PROVIDER_CATALOG", () => {
  test("every provider in PROVIDER_CATALOG passes profile-fragment validation", () => {
    for (const entry of PROVIDER_CATALOG) {
      const fragment = {
        label: `Test profile for ${entry.id}`,
        provider: entry.id,
        model: entry.defaultModel,
      };
      const result = ProfileEntry.safeParse(fragment);
      expect(result.success).toBe(true);
      if (!result.success) {
        // Surface the actual zod error for fast triage when this regresses.
        throw new Error(
          `ProfileEntry rejected provider="${entry.id}" — ${JSON.stringify(result.error.issues)}`,
        );
      }
    }
  });

  test("an unknown provider is still rejected (closed enum)", () => {
    const fragment = {
      label: "Bogus",
      provider: "definitely-not-a-real-provider",
      model: "x",
    };
    const result = ProfileEntry.safeParse(fragment);
    expect(result.success).toBe(false);
  });
});
