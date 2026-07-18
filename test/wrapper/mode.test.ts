import { describe, expect, test } from "vitest";
import { argsWithHarnessModel } from "../../src/wrapper/internal/mode.ts";
import {
  argsWithHarnessEffort,
  harnessSupportsEffort,
} from "../../src/wrapper/internal/effort.ts";
import { validateConfig } from "../../src/wrapper/internal/config.ts";

describe("argsWithHarnessModel", () => {
  const cases: {
    name: string;
    harness: string;
    args: string[];
    model: string;
    want: string[];
  }[] = [
    {
      name: "claude model prepended",
      harness: "claude",
      args: ["-p", "prompt"],
      model: "claude-opus-4-8",
      want: ["--model", "claude-opus-4-8", "-p", "prompt"],
    },
    {
      name: "claude-code normalizes to claude",
      harness: "claude-code",
      args: ["-p"],
      model: "opus",
      want: ["--model", "opus", "-p"],
    },
    {
      name: "existing --model wins",
      harness: "claude",
      args: ["--model", "sonnet", "-p"],
      model: "opus",
      want: ["--model", "sonnet", "-p"],
    },
    {
      name: "codex model as config override",
      harness: "codex",
      args: ["exec", "--json"],
      model: "o3",
      want: ["-c", 'model="o3"', "exec", "--json"],
    },
    {
      name: "codex existing model wins",
      harness: "codex",
      args: ["-c", 'model="gpt"', "exec"],
      model: "o3",
      want: ["-c", 'model="gpt"', "exec"],
    },
    {
      name: "empty model leaves args unchanged",
      harness: "claude",
      args: ["-p"],
      model: "",
      want: ["-p"],
    },
    {
      name: "unsupported harness leaves args unchanged",
      harness: "opencode",
      args: ["-p"],
      model: "x",
      want: ["-p"],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(argsWithHarnessModel(tc.harness, tc.args, tc.model)).toEqual(
        tc.want,
      );
    });
  }
});

test("harness name normalization: claude-code reaches claude effort path", () => {
  expect(harnessSupportsEffort("claude-code")).toBe(true);
  expect(argsWithHarnessEffort("claude-code", ["-p"], "high")).toEqual([
    "--effort",
    "high",
    "-p",
  ]);
});

test("validateConfig accepts claude-code + effort", () => {
  const err = validateConfig({
    binaryPath: "x",
    stdout: {},
    harness: "claude-code",
    effort: "high",
  });
  expect(err).toBeNull();
});
