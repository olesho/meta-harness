// CodexAdapter behaviour around a pending approval prompt (META-HARNESS-46):
// the InputRequested/InputResolved transitions driven by onScreen, and the
// onWrapperStatus override that stops a turn falsely completing while a
// blocking dialog is still on screen.

import { describe, expect, test } from "vitest"
import { newScreen } from "../../../src/screen/index.ts"
import * as codex from "../../../src/turns/harness/codex.ts"
import { Errored, InputRequested, InputResolved, TurnComplete } from "../../../src/turns/index.ts"
import {
  StatusAPIError,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
  StatusWaitingForInput,
} from "../../../src/turns/wrapper.ts"
import { corpusBytes } from "../corpus.ts"
import { textSnap } from "../corpus.ts"

async function corpusText(scenario: string): Promise<string> {
  const bytes = corpusBytes("codex", scenario)
  expect(bytes, `corpus recording codex/${scenario} is missing`).not.toBeNull()
  const scr = newScreen(120, 40)
  await scr.write(bytes!)
  return scr.snapshot().text
}

// The post-answer screen: dialog gone, idle composer back.
const readyScreen = [
  "• Ran touch /tmp/probe",
  "",
  "› ",
  "",
  "  gpt-5.6-sol default · /private/tmp",
].join("\n")

const updateNoticeScreen = [
  "  ✨  Update available! 0.140.0 -> 0.141.0",
  "",
  "› 1. Update now",
  "  2. Skip",
  "",
  "  Press enter to continue",
].join("\n")

describe("CodexAdapter.onScreen — approval prompt transitions", () => {
  test("InputRequested once, then InputResolved when the dialog clears", async () => {
    const dialog = await corpusText("approval-command")
    const a = codex.New()

    const first = a.onScreen(textSnap(dialog))
    expect(first.length).toBe(1)
    expect(first[0]!.kind).toBe(InputRequested)
    expect(first[0]!.input!.kind).toBe(codex.KindApproval)
    const id = first[0]!.input!.id
    expect(id).not.toBe("")

    // Redraw of the same dialog — the id is unchanged, so nothing re-fires.
    expect(a.onScreen(textSnap(dialog)).length).toBe(0)

    const cleared = a.onScreen(textSnap(readyScreen))
    expect(cleared.length).toBe(1)
    expect(cleared[0]!.kind).toBe(InputResolved)
    expect(cleared[0]!.input!.id).toBe(id)
    expect(cleared[0]!.input!.kind).toBe(codex.KindApproval)

    // Resolved once only.
    expect(a.onScreen(textSnap(readyScreen)).length).toBe(0)
  })
})

describe("CodexAdapter.onWrapperStatus — no false TurnComplete mid-dialog", () => {
  test("waiting_for_input completes the turn when no dialog is pending", () => {
    const a = codex.New()
    const evs = a.onWrapperStatus(StatusWaitingForInput, "quiet")
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("waiting_for_input is suppressed while an approval prompt is pending", async () => {
    // The bug this feature fixes: the wrapper classifies the quiet dialog screen
    // as waiting_for_input, GenericAdapter maps that to TurnComplete, and the
    // turn completes while the approval dialog is still up — the consumer then
    // finds no task_complete in the rollout and treats the reply as errored.
    const a = codex.New()
    a.onScreen(textSnap(await corpusText("approval-command")))
    expect(a.onWrapperStatus(StatusWaitingForInput, "quiet")).toEqual([])
  })

  test("waiting_for_input is suppressed while an interstitial is still clearing", async () => {
    // Intended scope note: lastInputID stays set between InputRequested and
    // InputResolved even for an auto-dismissed interstitial (the chat layer has
    // written the dismiss keys but the next dialog-free onScreen has not landed).
    // A turn must not complete while ANY structured dialog is on screen.
    const a = codex.New()
    const evs = a.onScreen(textSnap(updateNoticeScreen))
    expect(evs[0]!.kind).toBe(InputRequested)
    expect(evs[0]!.input!.kind).toBe(codex.KindUpdateNotice)
    expect(a.onWrapperStatus(StatusWaitingForInput, "quiet")).toEqual([])
  })

  test("waiting_for_input completes again once the dialog resolves", async () => {
    const a = codex.New()
    a.onScreen(textSnap(await corpusText("approval-command")))
    expect(a.onWrapperStatus(StatusWaitingForInput, "quiet")).toEqual([])

    const cleared = a.onScreen(textSnap(readyScreen))
    expect(cleared[0]!.kind).toBe(InputResolved)

    const evs = a.onWrapperStatus(StatusWaitingForInput, "quiet")
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("non-waiting_for_input statuses still delegate mid-dialog", async () => {
    // A crash / API error during a dialog must still surface — only the
    // waiting_for_input → TurnComplete mapping is suppressed.
    for (const [status, want] of [
      [StatusFailed, Errored],
      [StatusInterrupted, Errored],
      [StatusIdle, Errored],
      [StatusAPIError, "blocked"],
    ] as const) {
      const a = codex.New()
      a.onScreen(textSnap(await corpusText("approval-command")))
      const evs = a.onWrapperStatus(status, "boom")
      expect(evs.length, `status ${status} was swallowed mid-dialog`).toBe(1)
      expect(evs[0]!.kind).toBe(want)
    }
  })
})
