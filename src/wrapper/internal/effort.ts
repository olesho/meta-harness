// Per-harness reasoning-effort translation: CLI args (Claude --effort, Codex
// -c model_reasoning_effort) and env (Gemini system-settings file).

import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  argsContainConfigKey,
  argsContainFlag,
  normHarness,
  prependArgs,
} from "./harnessargs.ts"

export function isSupportedEffort(effort: string): boolean {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return true
    default:
      return false
  }
}

export function harnessSupportsEffort(harness: string): boolean {
  switch (normHarness(harness)) {
    case "claude":
    case "claude-code":
    case "codex":
    case "gemini":
    case "gemini-cli":
      return true
    default:
      return false
  }
}

function codexEffort(effort: string): string {
  return effort === "max" ? "xhigh" : effort
}

/** Prepend a per-harness effort flag/config override. An existing one wins. */
export function argsWithHarnessEffort(
  harness: string,
  args: string[],
  effort: string,
): string[] {
  if (effort === "") return args
  switch (normHarness(harness)) {
    case "claude":
    case "claude-code":
      if (argsContainFlag(args, "--effort")) return args
      return prependArgs(args, "--effort", effort)
    case "codex":
      if (argsContainConfigKey(args, "model_reasoning_effort")) return args
      return prependArgs(
        args,
        "-c",
        `model_reasoning_effort="${codexEffort(effort)}"`,
      )
    default:
      return args
  }
}

function envHasKey(env: string[], key: string): boolean {
  const prefix = key + "="
  return env.some((entry) => entry.startsWith(prefix))
}

/**
 * Append the Gemini system-settings env var pointing at a freshly-written
 * settings file encoding the requested thinking budget. Leaves env unchanged
 * for non-Gemini harnesses, empty effort, or an already-set settings path.
 */
export function envWithHarnessEffort(
  harness: string,
  env: string[] | null,
  effort: string,
): string[] {
  const h = normHarness(harness)
  if (
    effort === "" ||
    (h !== "gemini" && h !== "gemini-cli") ||
    (env !== null && envHasKey(env, "GEMINI_CLI_SYSTEM_SETTINGS_PATH"))
  ) {
    return env ?? []
  }
  const settingsPath = writeGeminiEffortSettings(effort)
  if (settingsPath === "") return env ?? []
  let base = env
  if (base === null) {
    base = Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`)
  }
  return [...base, "GEMINI_CLI_SYSTEM_SETTINGS_PATH=" + settingsPath]
}

function geminiThinkingBudget(effort: string): number | null {
  switch (effort) {
    case "low":
      return 512
    case "medium":
      return 2048
    case "high":
      return 8192
    case "xhigh":
      return 16384
    case "max":
      return -1
    default:
      return null
  }
}

function writeGeminiEffortSettings(effort: string): string {
  const budget = geminiThinkingBudget(effort)
  if (budget === null) return ""
  try {
    const dir = mkdtempSync(join(tmpdir(), "harness-wrapper-gemini-effort-"))
    const path = join(dir, "settings.json")
    const settings = `{
  "modelConfigs": {
    "customOverrides": [
      {
        "match": {
          "overrideScope": "core"
        },
        "modelConfig": {
          "generateContentConfig": {
            "thinkingConfig": {
              "thinkingBudget": ${budget}
            }
          }
        }
      }
    ]
  }
}
`
    const fd = openSync(path, "w")
    try {
      writeSync(fd, settings)
    } finally {
      closeSync(fd)
    }
    return path
  } catch {
    return ""
  }
}
