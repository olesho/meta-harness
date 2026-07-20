// Shared HARNESS_WRAPPER_RUN_TIMEOUT parsing — the single home of the Go
// duration parser and the default deadline both CLIs (run + structured-runner)
// agree on. run.ts's re-exported surface is covered in test/cli/run.test.ts.

import { describe, expect, test } from "vitest";

import {
  DEFAULT_RUN_TIMEOUT_MS,
  parseGoDuration,
  parseTimeoutMs,
} from "../../src/turnproto/index.ts";

describe("DEFAULT_RUN_TIMEOUT_MS", () => {
  test("is the agreed 15m default shared with the Go wrapper", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(900_000);
  });
});

describe("parseGoDuration", () => {
  test("common Go durations", () => {
    expect(parseGoDuration("15m")).toBe(900_000);
    expect(parseGoDuration("90s")).toBe(90_000);
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("500ms")).toBe(500);
    expect(parseGoDuration("1.5s")).toBe(1500);
  });
  test("malformed → null", () => {
    expect(parseGoDuration("")).toBeNull();
    expect(parseGoDuration("abc")).toBeNull();
    expect(parseGoDuration("15")).toBeNull();
    expect(parseGoDuration("15m garbage")).toBeNull();
  });
});

describe("parseTimeoutMs", () => {
  test("valid duration wins; unset/empty/invalid → default", () => {
    expect(parseTimeoutMs("30s")).toBe(30_000);
    expect(parseTimeoutMs(undefined)).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(parseTimeoutMs("")).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(parseTimeoutMs("garbage")).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });
  test("optional defaultMs parameter overrides the fallback only", () => {
    expect(parseTimeoutMs(undefined, 1234)).toBe(1234);
    expect(parseTimeoutMs("garbage", 1234)).toBe(1234);
    expect(parseTimeoutMs("2s", 1234)).toBe(2000);
  });
});
