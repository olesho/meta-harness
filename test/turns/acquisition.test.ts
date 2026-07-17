// Covers the acquisition-mode vocabulary added in META-HARNESS-54: the turns
// barrel re-exports StreamParser / AcquisitionMode, describeAcquisitionMode maps
// each value, and all four A1 adapters report streamInterleaved() === false
// (not Stream-eligible; no parseStreamLine implemented).

import { describe, expect, test } from "vitest"
import * as turns from "../../src/turns/index.ts"
import type { AcquisitionMode, StreamParser } from "../../src/turns/index.ts"
import {
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
  describeAcquisitionMode,
} from "../../src/turns/index.ts"
import * as claudecode from "../../src/turns/harness/claudecode.ts"
import * as codex from "../../src/turns/harness/codex.ts"
import * as opencode from "../../src/turns/harness/opencode.ts"
import * as pi from "../../src/turns/harness/pi.ts"

describe("acquisition-mode vocabulary", () => {
  test("barrel re-exports the mode values", () => {
    expect(turns.AcquisitionModeOff).toBe("off")
    expect(turns.AcquisitionModeStream).toBe("stream")
    expect(turns.AcquisitionModeHooks).toBe("hooks")
    expect(typeof turns.describeAcquisitionMode).toBe("function")
  })

  test("describeAcquisitionMode maps each value to its log label", () => {
    expect(describeAcquisitionMode(AcquisitionModeOff)).toBe("off")
    expect(describeAcquisitionMode(AcquisitionModeStream)).toBe("stream")
    expect(describeAcquisitionMode(AcquisitionModeHooks)).toBe("hooks")
  })

  test("StreamParser type is usable structurally from the barrel", () => {
    // The barrel must export StreamParser (compile-time check via the import).
    const noop: StreamParser = { parseStreamLine: () => [] }
    expect(noop.parseStreamLine("not json")).toEqual([])
    // AcquisitionMode is a type; assigning a const value satisfies it.
    const m: AcquisitionMode = AcquisitionModeStream
    expect(m).toBe("stream")
  })
})

describe("A1 adapters are not Stream-eligible", () => {
  const adapters = [
    ["claude-code", claudecode.New()],
    ["codex", codex.New()],
    ["opencode", opencode.New()],
    ["pi", pi.New()],
  ] as const

  test.each(adapters)("%s: streamInterleaved() === false", (_name, adapter) => {
    expect(adapter.streamInterleaved()).toBe(false)
  })

  test.each(adapters)("%s: no parseStreamLine implemented", (_name, adapter) => {
    expect((adapter as { parseStreamLine?: unknown }).parseStreamLine).toBeUndefined()
  })
})
