/**
 * Guardian binding drift healing for the max channel.
 *
 * The gateway owns guardian binding creation at startup
 * (`ensureMaxGuardianBinding` in gateway/src/auth/guardian-bootstrap.ts).
 * This module provides drift-healing logic which must remain
 * assistant-side since it reacts to incoming JWT principals.
 */

import {
  findGuardianForChannel,
  updateContactPrincipalAndChannel,
} from "../contacts/contact-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-max-migration");

/**
 * Heal guardian binding drift for the max channel.
 *
 * After a DB reset, the daemon creates a new guardian binding with a fresh
 * `max-principal-<uuid>`, but the client may still hold a valid JWT
 * signed with the surviving signing key containing the old principal.
 * The JWT passes signature validation but trust resolution returns
 * `unknown` because the principals don't match.
 *
 * This function detects that scenario and updates the binding to match
 * the JWT's principal. Only heals when both the stored and incoming
 * principals have the `max-principal-` prefix (both auto-generated,
 * no external identity meaning). The JWT's signature proves it was
 * minted by this daemon's signing key.
 *
 * Returns true if healing occurred, false otherwise.
 */
export function healGuardianBindingDrift(incomingPrincipalId: string): boolean {
  if (!incomingPrincipalId.startsWith("max-principal-")) {
    return false;
  }

  const guardianResult = findGuardianForChannel("max");
  if (!guardianResult) return false;

  const currentPrincipalId = guardianResult.contact.principalId;
  if (!currentPrincipalId?.startsWith("max-principal-")) return false;
  if (currentPrincipalId === incomingPrincipalId) return false;

  const updated = updateContactPrincipalAndChannel(
    guardianResult.contact.id,
    guardianResult.channel.id,
    incomingPrincipalId,
  );

  if (!updated) {
    log.warn(
      {
        oldPrincipalId: currentPrincipalId,
        newPrincipalId: incomingPrincipalId,
      },
      "Skipped guardian binding drift heal — address collision on contact_channels",
    );
    return false;
  }

  log.info(
    {
      oldPrincipalId: currentPrincipalId,
      newPrincipalId: incomingPrincipalId,
    },
    "Healed max guardian binding drift — updated principalId to match JWT actor",
  );

  return true;
}
