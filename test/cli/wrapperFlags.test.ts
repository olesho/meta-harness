// Unit + contract tests for src/cli/wrapperFlags.ts.
//
// The golden test freezes the CLI flag surface the same way Go's
// cmd/harness-wrapper/contract_test.go does against testdata/flags.golden —
// but as its own, separate golden (test/cli/testdata/wrapper-flags.golden):
// this is NOT folded into test/contract.test.ts's ts_surface.golden, since
// that golden only freezes PUBLIC_BARRELS exports and src/cli/ isn't one
// (flat CLI-entrypoint files, same precedent as src/cli/run.ts).

import { describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseHarnessWrapperArgs,
  renderFlagSurface,
} from "../../src/cli/wrapperFlags.ts";

const here = dirname(fileURLToPath(import.meta.url));

function assertGolden(name: string, got: string): void {
  const path = join(here, "testdata", name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, got);
    return;
  }
  const want = readFileSync(path, "utf8");
  expect(got).toBe(want);
}

describe("renderFlagSurface", () => {
  test("matches the frozen contract", () => {
    assertGolden("wrapper-flags.golden", renderFlagSurface());
  });
});

describe("parseHarnessWrapperArgs", () => {
  test("missing -- separator errors", () => {
    const { result, err } = parseHarnessWrapperArgs(["claude"]);
    expect(result).toBeNull();
    expect(err?.message).toContain("missing -- separator");
  });

  test("missing harness name before -- errors", () => {
    const { result, err } = parseHarnessWrapperArgs(["--"]);
    expect(result).toBeNull();
    expect(err?.message).toContain("missing harness name");
  });

  test("more than one harness name before -- errors", () => {
    const { result, err } = parseHarnessWrapperArgs(["claude", "codex", "--"]);
    expect(result).toBeNull();
    expect(err?.message).toContain("expected exactly one harness name");
  });

  test("bare harness name", () => {
    const { result, err } = parseHarnessWrapperArgs(["claude", "--"]);
    expect(err).toBeNull();
    expect(result?.harnessName).toBe("claude");
    expect(result?.harnessArgs).toEqual([]);
  });

  test("flags before name, harness args after --", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--effort",
      "high",
      "--model",
      "opus",
      "claude",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(err).toBeNull();
    expect(result?.effort).toBe("high");
    expect(result?.model).toBe("opus");
    expect(result?.harnessName).toBe("claude");
    expect(result?.harnessArgs).toEqual(["--dangerously-skip-permissions"]);
  });

  test("--flag=value form", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--effort=low",
      "--model=x",
      "--permission-mode=plan",
      "claude",
      "--",
    ]);
    expect(err).toBeNull();
    expect(result?.effort).toBe("low");
    expect(result?.model).toBe("x");
    expect(result?.permissionMode).toBe("plan");
  });

  test("--permission-mode in the separated form", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--permission-mode",
      "bypass",
      "claude",
      "--",
    ]);
    expect(err).toBeNull();
    expect(result?.permissionMode).toBe("bypass");
    expect(result?.harnessName).toBe("claude");
  });

  test("permissionMode defaults to the empty string", () => {
    const { result, err } = parseHarnessWrapperArgs(["claude", "--"]);
    expect(err).toBeNull();
    expect(result?.permissionMode).toBe("");
  });

  test("--trace-stderr boolean flag", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--trace-stderr",
      "claude",
      "--",
    ]);
    expect(err).toBeNull();
    expect(result?.traceStderr).toBe(true);
  });

  test("--trace-file and --trace-stderr are mutually exclusive", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--trace-file",
      "/tmp/x.ndjson",
      "--trace-stderr",
      "claude",
      "--",
    ]);
    expect(result).toBeNull();
    expect(err?.message).toContain("mutually exclusive");
  });

  test("--tmux-session and --tmux-child are mutually exclusive", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "--tmux-session",
      "a",
      "--tmux-child",
      "a",
      "claude",
      "--",
    ]);
    expect(result).toBeNull();
    expect(err?.message).toContain("mutually exclusive");
  });

  test("unknown flag errors", () => {
    const { result, err } = parseHarnessWrapperArgs(["--nope", "claude", "--"]);
    expect(result).toBeNull();
    expect(err?.message).toContain("flag provided but not defined");
  });

  test("flag missing a value errors", () => {
    const { result, err } = parseHarnessWrapperArgs(["--effort", "--"]);
    expect(result).toBeNull();
    expect(err?.message).toContain("flag needs an argument");
  });

  test("harness args after -- are passed through verbatim, including flag-shaped tokens", () => {
    const { result, err } = parseHarnessWrapperArgs([
      "claude",
      "--",
      "--effort",
      "should-not-be-parsed",
      "--",
    ]);
    expect(err).toBeNull();
    expect(result?.harnessArgs).toEqual([
      "--effort",
      "should-not-be-parsed",
      "--",
    ]);
  });
});
