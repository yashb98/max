#!/usr/bin/env bun
/**
 * Prompts the user for the Discord bot token via the species-specific
 * secure credential prompt and stores it in the credential vault under
 * `discord_channel:bot_token`.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeMax(): Promise<void> {
  const args = [
    "credentials",
    "prompt",
    "--service",
    "discord_channel",
    "--field",
    "bot_token",
    "--label",
    "Discord Bot Token",
    "--placeholder",
    "MTk4NjIyNDgzNzAyNDU0...",
    "--description",
    "Paste the bot token from the Bot tab of your Discord application. Discord shows it only once.",
    "--allowed-domains",
    "discord.com",
    "--allowed-tools",
    "bash",
    "--injection-templates",
    JSON.stringify([
      {
        hostPattern: "discord.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bot ",
      },
    ]),
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
