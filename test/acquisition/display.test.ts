import { describe, expect, test } from "vitest";

import {
  displaySinkCap,
  newDisplaySink,
} from "../../src/acquisition/internal/display.ts";

describe("displaySink", () => {
  test("delivers pushed lines to the callback asynchronously", async () => {
    const got: string[] = [];
    const sink = newDisplaySink((line) => got.push(line));
    sink.push("a");
    sink.push("b");
    sink.push("c");
    // Delivery is async: nothing yet on the same synchronous tick.
    expect(got).toEqual([]);
    await Promise.resolve();
    await new Promise((r) => {
      queueMicrotask(() => {
        r(null);
      });
    });
    expect(got).toEqual(["a", "b", "c"]);
    expect(sink.close()).toBe(0);
  });

  test("drops the OLDEST lines under a forced-full queue with an exact drop count", () => {
    // No microtask boundary is crossed, so the drain never runs: every push
    // beyond the cap forces an eviction of the oldest queued line.
    const sink = newDisplaySink(() => {});
    const extra = 500;
    for (let i = 0; i < displaySinkCap + extra; i++) {
      sink.push(`line-${i}`);
    }
    expect(sink.close()).toBe(extra);
  });

  test("close flushes the remaining queue and returns the drop count", () => {
    const got: string[] = [];
    const sink = newDisplaySink((line) => got.push(line));
    const extra = 3;
    for (let i = 0; i < displaySinkCap + extra; i++) sink.push(`l${i}`);
    const dropped = sink.close();
    expect(dropped).toBe(extra);
    // The surviving cap-worth of lines are the NEWEST ones, delivered on close.
    expect(got.length).toBe(displaySinkCap);
    expect(got[0]).toBe(`l${extra}`);
    expect(got[got.length - 1]).toBe(`l${displaySinkCap + extra - 1}`);
  });

  test("a throwing callback is swallowed, never crashing the drainer", () => {
    let calls = 0;
    const sink = newDisplaySink(() => {
      calls++;
      throw new Error("boom");
    });
    sink.push("x");
    sink.push("y");
    // close drains synchronously; the throws must not propagate.
    expect(() => sink.close()).not.toThrow();
    expect(calls).toBe(2);
  });

  test("push after close is a no-op", () => {
    const got: string[] = [];
    const sink = newDisplaySink((line) => got.push(line));
    expect(sink.close()).toBe(0);
    sink.push("late");
    expect(sink.close()).toBe(0);
    expect(got).toEqual([]);
  });

  test("a null/absent callback yields a no-op sink", () => {
    const sink = newDisplaySink(null);
    sink.push("ignored");
    expect(sink.close()).toBe(0);
    const sink2 = newDisplaySink();
    sink2.push("ignored");
    expect(sink2.close()).toBe(0);
  });
});
