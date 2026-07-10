// End-to-end wiring on fixture data: discover the list from a recorded picker,
// pick one model, and assert the wrapper's selection path produces the right
// CLI args and that the pick validates against the curated registry.

import { describe, expect, test } from "vitest"
import { newScreen } from "../../src/screen/index.ts"
import { parseModelPicker, isKnownModel } from "../../src/discovery/models.ts"
import { argsWithHarnessModel } from "../../src/wrapper/internal/mode.ts"
import { corpusBytes } from "../turns/corpus.ts"

async function discoverFromFixture(harness: string) {
  const bytes = corpusBytes(harness, "model-picker")
  expect(bytes).not.toBeNull()
  const scr = newScreen(120, 40)
  await scr.write(bytes!)
  return parseModelPicker(scr.snapshot().text, harness)
}

describe("discover then select", () => {
  test("claude-code: pick sonnet → --model + isKnownModel", async () => {
    const models = await discoverFromFixture("claude-code")
    const pick = models.find((m) => m.id === "sonnet")!
    expect(pick).toBeDefined()
    expect(isKnownModel("claude-code", pick.id)).toBe(true)
    expect(argsWithHarnessModel("claude-code", ["-p", "hi"], pick.id)).toEqual([
      "--model",
      "sonnet",
      "-p",
      "hi",
    ])
  })

  test("codex: pick gpt-5.4 → -c model= + isKnownModel", async () => {
    const models = await discoverFromFixture("codex")
    const pick = models.find((m) => m.id === "gpt-5.4")!
    expect(pick).toBeDefined()
    expect(isKnownModel("codex", pick.id)).toBe(true)
    expect(argsWithHarnessModel("codex", ["exec"], pick.id)).toEqual([
      "-c",
      'model="gpt-5.4"',
      "exec",
    ])
  })

  test("every discovered claude model is selectable and validates", async () => {
    const models = await discoverFromFixture("claude-code")
    for (const m of models) {
      expect(isKnownModel("claude-code", m.id)).toBe(true)
      expect(argsWithHarnessModel("claude-code", [], m.id)).toEqual(["--model", m.id])
    }
  })
})
