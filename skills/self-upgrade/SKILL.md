---
name: self-upgrade
description: Upgrade max to the latest version, restart the assistant, and restart the gateway
compatibility: "Designed for Max personal assistants"
metadata:
  emoji: "⬆️"
  max:
    display-name: "Self Upgrade"
---

You are performing a self-upgrade of the Max assistant. Follow these steps **in order**. Use the `bash` tool to run each command. Confirm each step succeeds before moving to the next.

## Step 1: Record the current version

```bash
max --version
```

Save this value to report later.

## Step 2: Install the latest max

```bash
bun install -g max@latest
```

After updating, verify the new version:

```bash
max --version
```

## Step 3: Restart the gateway

If a gateway process is running, restart it so it picks up any protocol or dependency changes from the new version:

```bash
pgrep -f 'max-gateway|gateway/src/index.ts' || echo "No gateway process found"
```

If a gateway PID is found, send it SIGTERM so it drains gracefully:

```bash
pkill -TERM -f 'max-gateway|gateway/src/index.ts'
```

Then start the gateway again using whatever method the user's deployment uses (e.g. `bun run gateway/src/index.ts`, a systemd service, or a container orchestrator). If you are unsure how the gateway is deployed, ask the user.

## Step 4: Restart the assistant

Use `max sleep` to stop the running assistant and gateway, then `max wake` to start them again from the updated binary:

```bash
max sleep && max wake
```

Verify it is running:

```bash
max ps
```

**Important:** This is the last step because the current assistant process is the one executing this conversation. After the restart, the new assistant takes over and this conversation ends gracefully.

## After Upgrade

Report back to the user with:

- The previous and new max version
- Assistant status (running, PID)
- Gateway status (restarted or not found)
- Any errors encountered during the process
