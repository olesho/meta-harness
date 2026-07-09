// Live, opt-in end-to-end check of discoverModels against the INSTALLED harness
// binary. Skipped by default (mirrors test/oneshot/live_claude.test.ts):
//
//   LIVE_MODELS=1 bun test test/discovery/models_live.test.ts
//   LIVE_MODELS=1 LIVE_CODEX=1 bun test test/discovery/models_live.test.ts
//
// It launches the real CLI, sends `/model`, scrapes the picker, and asserts a
// non-empty, plausible model list — the durable guard against the live picker
// layout drifting away from parseModelPicker.

import { describe, expect, test } from "bun:test"
import { discoverModels, isKnownModel } from "../../src/discovery/models.ts"
import { Context } from "../../src/internal/async/index.ts"

const liveClaude = process.env.LIVE_MODELS === "1"
const liveCodex = process.env.LIVE_MODELS === "1" && process.env.LIVE_CODEX === "1"
const TEST_TIMEOUT = 60_000

describe.if(liveClaude)("discoverModels (live claude-code)", () => {
  test(
    "returns the real model list",
    async () => {
      const { ctx } = Context.withDeadline(Context.background(), TEST_TIMEOUT - 5_000)
      const models = await discoverModels(ctx, {
        harness: "claude-code",
        binaryPath: process.env.LIVE_CLAUDE_BIN ?? "claude",
      })
      expect(models.length).toBeGreaterThan(0)
      // At least one discovered model should be one we know.
      expect(models.some((m) => isKnownModel("claude-code", m.id))).toBe(true)
    },
    TEST_TIMEOUT,
  )
})

describe.if(liveCodex)("discoverModels (live codex)", () => {
  test(
    "returns the real model list",
    async () => {
      const { ctx } = Context.withDeadline(Context.background(), TEST_TIMEOUT - 5_000)
      const models = await discoverModels(ctx, {
        harness: "codex",
        binaryPath: process.env.LIVE_CODEX_BIN ?? "codex",
      })
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((m) => m.id.length > 0)).toBe(true)
    },
    TEST_TIMEOUT,
  )
})

// Keep the file non-empty for the default (skipped) run so `bun test` reports it.
test("models_live: live checks are opt-in", () => {
  expect(true).toBe(true)
})
