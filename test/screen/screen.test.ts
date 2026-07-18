import { describe, expect, test } from "vitest";
import { newScreen, Screen } from "../../src/screen/index.ts";

// Mirrors harness-wrapper/pkg/screen/screen_test.go. Assertions are
// contains/regex/event-count based, never exact full-screen equality.

describe("screen", () => {
  test("write and snapshot", async () => {
    const s = newScreen(40, 10);
    await s.write("\x1b[2J\x1b[Hhello \x1b[1mworld\x1b[0m");
    const snap = s.snapshot();
    expect(snap.text).toContain("hello world");
    expect(snap.generation).toBe(1);
    expect(snap.cols).toBe(40);
    expect(snap.rows).toBe(10);
  });

  test("snapshot preserves trailing whitespace per row", async () => {
    const s = newScreen(20, 3);
    await s.write("hi");
    const snap = s.snapshot();
    // Rows are joined top-to-bottom with one '\n' each; row width is preserved.
    const lines = snap.text.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/^hi\s+$/);
    expect(lines[0].length).toBe(20);
  });

  test("subscribe signals on write", async () => {
    const s = newScreen(40, 10);
    const [ch, unsub] = s.subscribe();
    try {
      await s.write("hi");
      const r = await Promise.race([
        ch.receive(),
        new Promise<{ ok: boolean; timeout: true }>((resolve) =>
          setTimeout(() => {
            resolve({ ok: false, timeout: true });
          }, 100),
        ),
      ]);
      expect("timeout" in r).toBe(false);
      expect(r.ok).toBe(true);
    } finally {
      unsub();
    }
  });

  test("subscribe coalesces", async () => {
    const s = newScreen(40, 10);
    const [ch, unsub] = s.subscribe();
    try {
      for (let i = 0; i < 100; i++) await s.write("x");
      // Exactly one pending signal regardless of write count.
      const first = await ch.receive();
      expect(first.ok).toBe(true);
      // A second receive must not already have a value pending.
      const second = await Promise.race([
        ch.receive().then((r) => ({ ...r, fired: true })),
        new Promise<{ fired: false }>((resolve) =>
          setTimeout(() => {
            resolve({ fired: false });
          }, 20),
        ),
      ]);
      expect("fired" in second && second.fired).toBe(false);
    } finally {
      unsub();
    }
  });

  test("unsubscribe stops delivery", async () => {
    const s = newScreen(40, 10);
    const [ch, unsub] = s.subscribe();
    unsub();
    await s.write("x");
    // Channel is closed: receive resolves { ok: false }, never a value.
    const r = await ch.receive();
    expect(r.ok).toBe(false);
  });

  test("concurrent writes -> generation 400", async () => {
    const s = new Screen(80, 24);
    const tasks = Array.from({ length: 8 }, () =>
      (async () => {
        for (let j = 0; j < 50; j++) {
          await s.write("abcdefghij");
          s.snapshot();
        }
      })(),
    );
    await Promise.all(tasks);
    expect(s.generation()).toBe(400);
  });

  test("resize updates dimensions and bumps generation", async () => {
    const s = newScreen(40, 10);
    await s.write("hi");
    const before = s.generation();
    s.resize(80, 24);
    const snap = s.snapshot();
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
    expect(snap.generation).toBe(before + 1);
  });

  test("non-positive dimensions fall back to defaults", () => {
    const s = newScreen(0, -5);
    const snap = s.snapshot();
    expect(snap.cols).toBe(120);
    expect(snap.rows).toBe(40);
  });
});
