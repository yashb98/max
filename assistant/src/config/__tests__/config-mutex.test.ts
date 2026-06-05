import { describe, expect, test } from "bun:test";

import { withConfigWriteLock } from "../config-mutex.js";

describe("withConfigWriteLock", () => {
  test("serializes concurrent writers", async () => {
    const log: string[] = [];
    const slow = withConfigWriteLock(async () => {
      log.push("slow-start");
      await new Promise((r) => setTimeout(r, 20));
      log.push("slow-end");
    });
    const fast = withConfigWriteLock(async () => {
      log.push("fast-start");
      log.push("fast-end");
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  });

  test("propagates errors and releases the lock", async () => {
    await expect(
      withConfigWriteLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent acquire works
    let ran = false;
    await withConfigWriteLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
