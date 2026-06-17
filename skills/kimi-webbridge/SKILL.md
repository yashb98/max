---
name: kimi-webbridge
description: Control the user's REAL browser (their logged-in sessions) — navigate, read via accessibility snapshot, click, fill, screenshot, evaluate JS, save PDF. Use whenever a task needs a real browser or the user's existing logins. Precise: targets elements by stable @e refs from snapshot, not pixels.
compatibility: "Designed for Max personal assistants; requires the kimi-webbridge daemon + browser extension"
metadata:
  emoji: "🧭"
  max:
    display-name: "Web Bridge (real browser)"
    user-invocable: true
---

# Web Bridge — control the user's real browser

Drives the user's actual logged-in browser via a local daemon. ALWAYS health-check first:
`~/.kimi-webbridge/bin/kimi-webbridge status` → need `running:true` and `extension_connected:true`.
If not healthy, read `~/.kimi/skills/kimi-webbridge/references/operations.md`.

## Calling convention
Run every action through the wrapper (returns JSON `{ok,data}`):
`bun skills/kimi-webbridge/scripts/webbridge.ts <action> '<jsonArgs>' <session>`

- **One task = one `session` name** (a tab group). Pass it as the 3rd arg on every call; never change it mid-task.
- Loop: `navigate` → `snapshot` (read accessibility tree + `@e` refs) → `click`/`fill` by `@e` ref → `snapshot`/`screenshot` to confirm.

## Tools (action → args)
| action | args | notes |
|---|---|---|
| navigate | `{"url","newTab":true,"group_title"}` | first call opens a tab |
| snapshot | `{}` | accessibility tree with `@e` refs — use to read + locate elements |
| click | `{"selector":"@e123"}` | real DOM click |
| fill | `{"selector":"@e45","value":"..."}` | inputs/textarea/contenteditable |
| evaluate | `{"code":"..."}` | run JS (wrap in IIFE; compact `JSON.stringify`) |
| screenshot | `{"format":"png","path":"/tmp/x.png"}` | returns a file path; view with ReadMediaFile |
| save_as_pdf | `{"path":"/tmp/x.pdf"}` | render page → PDF |
| list_tabs / close_tab / close_session | `{}` | tab/session management |

## On screenshots (kimi-agent)
`screenshot` returns a file path. On the kimi-agent model, call `ReadMediaFile` with that
absolute path to SEE it (the provider's media bridge + native multimodal ingestion).

## Safety
This controls the user's real browser/logins. Confirm before any state-changing action
(posting, purchasing, sending). Read-only navigation/snapshot/screenshot is safe.
