// Port of pkg/turns/harness/pi/corpus_test.go. Replays a REAL pi 0.76.0
// interactive-turn capture through the screen emulator, asserting the busy
// spinner fires mid-turn and the idle status line is recognized once settled.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { newScreen } from "../../../src/screen/index.ts"
import * as pi from "../../../src/turns/harness/pi.ts"

describe("pi corpus replay", () => {
  test("TUI turn", async () => {
    const path = new URL(
      "../../corpus/pi/tui-turn-raw.bin",
      import.meta.url,
    ).pathname
    if (!existsSync(path)) return // corpus not present → skip
    const raw = new Uint8Array(readFileSync(path))

    const a = pi.New()
    // A wide screen so absolute cursor positioning never wraps a status-line
    // token; width only affects wrapping, not content.
    const scr = newScreen(200, 50)

    // Feed cumulatively so a snapshot is taken during the busy phase and at the
    // settled end — the emulator state is incremental.
    let everBusy = false
    const chunks = 40
    const step = Math.floor(raw.length / chunks) + 1
    for (let off = 0; off < raw.length; off += step) {
      const end = Math.min(off + step, raw.length)
      await scr.write(raw.subarray(off, end))
      if (a.busy(scr.snapshot())) everBusy = true
    }

    const final = scr.snapshot()
    expect(everBusy).toBe(true)
    expect(a.busy(final)).toBe(false)
    expect(pi.PromptReady(final.text)).toBe(true)
    expect(final.text).toContain("PINEAPPLE")
  })
})
