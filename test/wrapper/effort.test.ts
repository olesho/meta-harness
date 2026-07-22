import { describe, expect, test } from "vitest";
import {
  argsWithHarnessEffort,
  harnessSupportsEffort,
  isSupportedEffort,
} from "../../src/wrapper/internal/effort.ts";

describe("argsWithHarnessEffort", () => {
  const cases: {
    name: string;
    harness: string;
    args: string[];
    effort: string;
    want: string[];
  }[] = [
    {
      name: "claude effort prepended",
      harness: "claude",
      args: ["-p", "prompt"],
      effort: "high",
      want: ["--effort", "high", "-p", "prompt"],
    },
    {
      name: "existing effort wins",
      harness: "claude",
      args: ["--effort", "low", "-p", "prompt"],
      effort: "high",
      want: ["--effort", "low", "-p", "prompt"],
    },
    {
      name: "empty effort leaves args unchanged",
      harness: "claude",
      args: ["-p", "prompt"],
      effort: "",
      want: ["-p", "prompt"],
    },
    {
      name: "codex effort prepended as config override",
      harness: "codex",
      args: ["exec", "--json"],
      effort: "high",
      want: ["-c", 'model_reasoning_effort="high"', "exec", "--json"],
    },
    {
      name: "codex max maps to xhigh",
      harness: "codex",
      args: ["exec", "--json"],
      effort: "max",
      want: ["-c", 'model_reasoning_effort="xhigh"', "exec", "--json"],
    },
    {
      name: "codex existing effort wins",
      harness: "codex",
      args: ["exec", "-c", 'model_reasoning_effort="low"', "--json"],
      effort: "high",
      want: ["exec", "-c", 'model_reasoning_effort="low"', "--json"],
    },
    {
      name: "unsupported harness leaves args unchanged",
      harness: "opencode",
      args: ["-p", "prompt"],
      effort: "high",
      want: ["-p", "prompt"],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(argsWithHarnessEffort(tc.harness, tc.args, tc.effort)).toEqual(
        tc.want,
      );
    });
  }
});

test("isSupportedEffort", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max"]) {
    expect(isSupportedEffort(e)).toBe(true);
  }
  expect(isSupportedEffort("ultra")).toBe(false);
});

test("harness name normalization: claude-code reaches claude effort path", () => {
  expect(harnessSupportsEffort("claude-code")).toBe(true);
  expect(argsWithHarnessEffort("claude-code", ["-p"], "high")).toEqual([
    "--effort",
    "high",
    "-p",
  ]);
});
