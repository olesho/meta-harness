// Port of pkg/turns/harness/opencode/opencode_test.go.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import * as opencode from "../../../src/turns/harness/opencode.ts"
import { TurnComplete } from "../../../src/turns/index.ts"
import { StatusWaitingForInput } from "../../../src/turns/index.ts"

describe("opencode adapter", () => {
  test("name", () => {
    expect(opencode.New().name()).toBe("opencode")
  })

  test("no screen events by default", async () => {
    const scr = newScreen(120, 40)
    await scr.write("any old content\r\n")
    expect(opencode.New().onScreen(scr.snapshot()).length).toBe(0)
  })

  test("fires on waiting_for_input", () => {
    const evs = opencode
      .New()
      .onWrapperStatus(StatusWaitingForInput, "prompt detected: (y/n)")
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("capabilities not yet implemented", () => {
    const a = opencode.New()
    expect(typeof (a as { readTranscript?: unknown }).readTranscript).not.toBe(
      "function",
    )
    expect(
      typeof (a as { extractSessionID?: unknown }).extractSessionID,
    ).not.toBe("function")
  })
})
