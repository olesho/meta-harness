import { expect, test } from "vitest";
import { validateConfig } from "../../src/wrapper/internal/config.ts";

test("validateConfig accepts claude-code + effort", () => {
  const err = validateConfig({
    binaryPath: "x",
    stdout: {},
    harness: "claude-code",
    effort: "high",
  });
  expect(err).toBeNull();
});
