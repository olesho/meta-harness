// Unit tests for src/cli/harnessResolver.ts's allow-list check. No binary or
// PATH involved — that's resolvePath()'s concern, already covered hermetically
// by test/discovery/resolve.test.ts.

import { describe, expect, test } from "vitest";

import {
  assertSupportedHarness,
  SUPPORTED_HARNESSES,
} from "../../src/cli/harnessResolver.ts";

describe("assertSupportedHarness", () => {
  test("accepts every Go-parity harness name minus gemini", () => {
    for (const name of ["claude", "codex", "opencode", "pi"]) {
      const { result, err } = assertSupportedHarness(name);
      expect(err).toBeNull();
      expect(result).toEqual({ harness: name, binaryPath: name });
    }
  });

  test("gemini is explicitly out of scope", () => {
    const { result, err } = assertSupportedHarness("gemini");
    expect(result).toBeNull();
    expect(err?.message).toContain("unsupported harness");
    expect(err?.message).not.toContain("gemini,");
  });

  test("unknown name errors listing the supported names", () => {
    const { result, err } = assertSupportedHarness("nope");
    expect(result).toBeNull();
    expect(err?.message).toContain('"nope"');
    for (const name of SUPPORTED_HARNESSES) {
      expect(err?.message).toContain(name);
    }
  });

  test("empty name errors", () => {
    const { result, err } = assertSupportedHarness("");
    expect(result).toBeNull();
    expect(err).not.toBeNull();
  });
});
