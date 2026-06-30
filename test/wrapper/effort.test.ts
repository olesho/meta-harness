import { describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import {
  argsWithHarnessEffort,
  envWithHarnessEffort,
  isSupportedEffort,
} from "../../src/wrapper/internal/effort.ts"

function envValue(env: string[], key: string): string {
  const prefix = key + "="
  for (const entry of env) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length)
  }
  return ""
}

describe("argsWithHarnessEffort", () => {
  const cases: { name: string; harness: string; args: string[]; effort: string; want: string[] }[] = [
    { name: "claude effort prepended", harness: "claude", args: ["-p", "prompt"], effort: "high", want: ["--effort", "high", "-p", "prompt"] },
    { name: "existing effort wins", harness: "claude", args: ["--effort", "low", "-p", "prompt"], effort: "high", want: ["--effort", "low", "-p", "prompt"] },
    { name: "empty effort leaves args unchanged", harness: "claude", args: ["-p", "prompt"], effort: "", want: ["-p", "prompt"] },
    { name: "codex effort prepended as config override", harness: "codex", args: ["exec", "--json"], effort: "high", want: ["-c", 'model_reasoning_effort="high"', "exec", "--json"] },
    { name: "codex max maps to xhigh", harness: "codex", args: ["exec", "--json"], effort: "max", want: ["-c", 'model_reasoning_effort="xhigh"', "exec", "--json"] },
    { name: "codex existing effort wins", harness: "codex", args: ["exec", "-c", 'model_reasoning_effort="low"', "--json"], effort: "high", want: ["exec", "-c", 'model_reasoning_effort="low"', "--json"] },
    { name: "unsupported harness leaves args unchanged", harness: "gemini", args: ["-p", "prompt"], effort: "high", want: ["-p", "prompt"] },
  ]
  for (const tc of cases) {
    test(tc.name, () => {
      expect(argsWithHarnessEffort(tc.harness, tc.args, tc.effort)).toEqual(tc.want)
    })
  }
})

test("isSupportedEffort", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max"]) {
    expect(isSupportedEffort(e)).toBe(true)
  }
  expect(isSupportedEffort("ultra")).toBe(false)
})

test("envWithHarnessEffort: gemini settings path (high → 8192)", () => {
  const got = envWithHarnessEffort("gemini", ["FOO=bar"], "high")
  const settingsPath = envValue(got, "GEMINI_CLI_SYSTEM_SETTINGS_PATH")
  expect(settingsPath).not.toBe("")
  try {
    const body = readFileSync(settingsPath, "utf8")
    expect(body).toContain('"thinkingBudget": 8192')
  } finally {
    rmSync(settingsPath, { force: true })
  }
})

test("envWithHarnessEffort: gemini max (→ -1)", () => {
  const got = envWithHarnessEffort("gemini", ["FOO=bar"], "max")
  const settingsPath = envValue(got, "GEMINI_CLI_SYSTEM_SETTINGS_PATH")
  expect(settingsPath).not.toBe("")
  try {
    const body = readFileSync(settingsPath, "utf8")
    expect(body).toContain('"thinkingBudget": -1')
  } finally {
    rmSync(settingsPath, { force: true })
  }
})

test("envWithHarnessEffort: existing settings path wins", () => {
  const got = envWithHarnessEffort(
    "gemini",
    ["GEMINI_CLI_SYSTEM_SETTINGS_PATH=/custom/settings.json"],
    "high",
  )
  expect(envValue(got, "GEMINI_CLI_SYSTEM_SETTINGS_PATH")).toBe("/custom/settings.json")
})
