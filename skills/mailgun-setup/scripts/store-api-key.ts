#!/usr/bin/env bun
/**
 * Prompts the user for a Mailgun API key and stores it in the credential vault.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeMax(): Promise<void> {
  const args = [
    "credentials",
    "prompt",
    "--service",
    "mailgun",
    "--field",
    "api_key",
    "--label",
    "Mailgun API Key",
    "--placeholder",
    "key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "--description",
    "Your Mailgun API key for sending emails",
    "--allowed-domains",
    "api.mailgun.net,api.eu.mailgun.net",
  ];

  const proc = Bun.spawn(["assistant", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  switch (species) {
    case "max":
      await storeMax();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=max.`,
      );
      process.exitCode = 1;
  }
}

main();
