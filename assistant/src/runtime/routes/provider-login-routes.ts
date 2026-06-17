/**
 * Drive an agentic provider's OAuth/login flow and capture the credential.
 *
 * POST /v1/provider-login  { provider }  → { success, reason?, error? }
 *
 * The handler invokes `loginProvider`, wiring its `onUrl` callback to
 * `openInHostBrowser` so the OAuth URL is opened in the user's browser via
 * the daemon's `open_url` event. This is a side-effecting POST (it spawns a
 * login flow and may persist a credential), so it must not be a GET.
 *
 * See assistant/docs/architecture/agent-sdk-login.md.
 */

import { z } from "zod";

import {
  loginProvider,
  type ProviderLoginResult,
} from "../../providers/provider-login.js";
import { openInHostBrowser } from "../../util/browser.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const RESULT_SHAPE = z.object({
  success: z.boolean(),
  reason: z
    .enum([
      "unsupported-provider",
      "cli-error",
      "cancelled",
      "no-token-captured",
      "subscription-required",
    ])
    .optional(),
  error: z.string().optional(),
});

export async function handleProviderLogin(
  args: RouteHandlerArgs = {},
): Promise<ProviderLoginResult> {
  const provider = args.body?.provider;
  if (!provider || typeof provider !== "string") {
    throw new BadRequestError("provider is required");
  }
  return loginProvider(provider, {
    onUrl: (url) => {
      void openInHostBrowser(url);
    },
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "provider_login",
    endpoint: "provider-login",
    method: "POST",
    summary:
      "Drive an agentic provider's OAuth login and capture the credential",
    description:
      "Starts the provider's login flow (kimi-agent via the SDK, claude-subscription via the CLI). The OAuth URL is opened in the host browser. Returns { success, reason?, error? }.",
    tags: ["providers"],
    responseBody: RESULT_SHAPE,
    handler: handleProviderLogin,
  },
];
