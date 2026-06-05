/**
 * Per-provider availability for setup-hint UX.
 *
 * GET /v1/provider-availability       → Record<string, ProviderAvailabilityStatus>
 * GET /v1/provider-availability/:id   → ProviderAvailabilityStatus
 *
 * Both accept `?fresh=true` to invalidate the daemon's process-lifetime
 * cli/login cache before evaluation. GET handlers are otherwise
 * side-effect-free per assistant/src/runtime/CLAUDE.md.
 *
 * See assistant/docs/architecture/claude-subscription-picker-setup-hint.md
 * for the full design + Swift consumer details.
 */

import { z } from "zod";

import {
  clearClaudeSubscriptionAvailabilityCache,
  getAllProviderAvailability,
  getProviderAvailabilityStatus,
} from "../../providers/provider-availability.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const STATUS_SHAPE = z.object({
  available: z.boolean(),
  reason: z
    .enum(["missing-cli", "not-logged-in", "not-enabled", "no-api-key"])
    .optional(),
});

function maybeBustCache({ queryParams }: RouteHandlerArgs): void {
  if (queryParams?.fresh === "true") clearClaudeSubscriptionAvailabilityCache();
}

async function handleList(args: RouteHandlerArgs) {
  maybeBustCache(args);
  return getAllProviderAvailability();
}

async function handleGet(args: RouteHandlerArgs) {
  maybeBustCache(args);
  const id = args.pathParams?.id;
  if (!id) return { available: false, reason: "no-api-key" as const };
  return getProviderAvailabilityStatus(id);
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "provider_availability_list",
    endpoint: "provider-availability",
    method: "GET",
    summary: "Per-provider availability for setup-hint UX",
    description:
      "Returns a map keyed by provider id. Each value is { available, reason? } where reason narrows the cause when unavailable (missing-cli, not-logged-in, not-enabled, no-api-key).",
    tags: ["providers"],
    queryParams: [
      {
        name: "fresh",
        type: "string",
        description:
          "Set to 'true' to invalidate the daemon's availability cache before evaluation.",
      },
    ],
    responseBody: z.record(z.string(), STATUS_SHAPE),
    handler: handleList,
  },
  {
    operationId: "provider_availability_get",
    endpoint: "provider-availability/:id",
    method: "GET",
    summary: "Single-provider availability lookup",
    tags: ["providers"],
    pathParams: [
      {
        name: "id",
        type: "string",
        description: "Provider id (e.g. 'claude-subscription', 'ollama').",
      },
    ],
    queryParams: [
      {
        name: "fresh",
        type: "string",
        description:
          "Set to 'true' to invalidate the daemon's availability cache before evaluation.",
      },
    ],
    responseBody: STATUS_SHAPE,
    handler: handleGet,
  },
];
