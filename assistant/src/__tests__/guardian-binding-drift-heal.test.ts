import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { healGuardianBindingDrift } from "../runtime/guardian-max-migration.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

describe("healGuardianBindingDrift", () => {
  beforeEach(() => {
    resetTables();
  });

  test("heals drift when both principals have max-principal- prefix", () => {
    // Simulate DB reset: new guardian binding with a different UUID
    createGuardianBinding({
      channel: "max",
      guardianExternalUserId: "max-principal-new-uuid",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "max-principal-new-uuid",
      verifiedVia: "startup-migration",
    });

    // Client arrives with the old JWT principal
    const healed = healGuardianBindingDrift("max-principal-old-uuid");
    expect(healed).toBe(true);

    // Guardian binding now matches the old JWT
    const guardian = findGuardianForChannel("max");
    expect(guardian).not.toBeNull();
    expect(guardian!.contact.principalId).toBe("max-principal-old-uuid");
    expect(guardian!.channel.externalUserId).toBe("max-principal-old-uuid");
  });

  test("no-op when principals already match", () => {
    createGuardianBinding({
      channel: "max",
      guardianExternalUserId: "max-principal-same",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "max-principal-same",
      verifiedVia: "startup-migration",
    });

    const healed = healGuardianBindingDrift("max-principal-same");
    expect(healed).toBe(false);
  });

  test("refuses to heal when incoming principal lacks max-principal- prefix", () => {
    createGuardianBinding({
      channel: "max",
      guardianExternalUserId: "max-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "max-principal-aaa",
      verifiedVia: "startup-migration",
    });

    // External/platform principal — should NOT be adopted
    const healed = healGuardianBindingDrift("platform-user-12345");
    expect(healed).toBe(false);

    // Guardian unchanged
    const guardian = findGuardianForChannel("max");
    expect(guardian!.contact.principalId).toBe("max-principal-aaa");
  });

  test("refuses to heal when stored principal lacks max-principal- prefix", () => {
    createGuardianBinding({
      channel: "max",
      guardianExternalUserId: "verified-phone-guardian",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "verified-phone-guardian",
      verifiedVia: "challenge",
    });

    // Even with a max-principal- incoming, don't overwrite a real binding
    const healed = healGuardianBindingDrift("max-principal-attacker");
    expect(healed).toBe(false);

    const guardian = findGuardianForChannel("max");
    expect(guardian!.contact.principalId).toBe("verified-phone-guardian");
  });

  test("returns false when no guardian binding exists", () => {
    const healed = healGuardianBindingDrift("max-principal-orphan");
    expect(healed).toBe(false);
  });
});
