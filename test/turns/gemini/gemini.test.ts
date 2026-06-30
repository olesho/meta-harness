// Port of pkg/turns/harness/gemini/gemini_test.go.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import * as gemini from "../../../src/turns/harness/gemini.ts"
import { TurnComplete } from "../../../src/turns/index.ts"
import { StatusWaitingForInput } from "../../../src/turns/index.ts"

describe("gemini adapter", () => {
  test("name", () => {
    expect(gemini.New().name()).toBe("gemini")
  })

  test("no screen events by default", async () => {
    const scr = newScreen(120, 40)
    await scr.write("any old content\r\n")
    expect(gemini.New().onScreen(scr.snapshot()).length).toBe(0)
  })

  test("fires on waiting_for_input", () => {
    const evs = gemini
      .New()
      .onWrapperStatus(StatusWaitingForInput, "prompt detected: (y/n)")
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("no session id yet", async () => {
    const scr = newScreen(120, 40)
    await scr.write(
      "gemini --resume 0281fd4a-0a10-4dfe-adca-9b61b3777255\r\n",
    )
    const [, ok] = gemini.New().extractSessionID(scr.snapshot())
    expect(ok).toBe(false)
  })
})
