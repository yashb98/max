#!/usr/bin/env bun
// Thin CLI over the kimi-webbridge daemon (controls the user's REAL browser).
// Usage:
//   bun webbridge.ts status
//   bun webbridge.ts <action> '<jsonArgs>' [session]
// Actions (daemon /command): navigate, find_tab, snapshot, click, fill, evaluate,
//   screenshot, network, upload, save_as_pdf, list_tabs, close_tab, close_session.

const DAEMON = process.env.KIMI_WEBBRIDGE_URL ?? "http://127.0.0.1:10086";
const [, , action, argsJson, session] = process.argv;

async function main(): Promise<void> {
  if (!action) {
    console.log(JSON.stringify({ ok: false, error: "usage: webbridge <action> [jsonArgs] [session]" }));
    return;
  }
  if (action === "status") {
    const home = process.env.HOME ?? "/Users/" + (process.env.USER ?? "");
    const proc = Bun.spawnSync([home + "/.kimi-webbridge/bin/kimi-webbridge", "status"]);
    console.log(proc.stdout.toString().trim() || JSON.stringify({ ok: false, error: "status unavailable" }));
    return;
  }
  let args: unknown = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    console.log(JSON.stringify({ ok: false, error: "invalid JSON args" }));
    return;
  }
  const body = JSON.stringify({ action, args, session: session ?? "vellum" });
  try {
    const r = await fetch(`${DAEMON}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await r.text();
    console.log(r.ok ? text : JSON.stringify({ ok: false, error: `daemon ${r.status}: ${text.slice(0, 200)}` }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `daemon unreachable: ${String(e)}` }));
  }
}
void main();
