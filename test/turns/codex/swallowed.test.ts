// META-HARNESS-21: CodexAdapter.promptNotAccepted — the swallowed-submit
// detector consulted by the chat idle-completion fallback. Screen shapes mirror
// the live 0.142.5 captures from the triage: a text+Enter burst consumed as a
// paste leaves the prompt sitting in the composer ("› <text>"), the screen
// otherwise settled, and no rollout is ever written.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import type { Snapshot } from "../../../src/screen/index.ts"
import * as codex from "../../../src/turns/harness/codex.ts"

async function snap(text: string): Promise<Snapshot> {
  const scr = newScreen(120, 40)
  await scr.write("\x1b[2J\x1b[H" + text.split("\n").join("\r\n") + "\r\n")
  return scr.snapshot()
}

const readyScreen = [
  ">_ OpenAI Codex (v0.142.5)",
  "",
  "  To get started, describe a task or try one of these commands:",
  "",
  "› ",
  "",
].join("\n")

// The live swallow shape: the sent text sits in the composer, the Enter
// rendered as a newline below it; no assistant output anywhere.
const swallowedScreen = [
  ">_ OpenAI Codex (v0.142.5)",
  "",
  "  To get started, describe a task or try one of these commands:",
  "",
  "› reply with just: ok",
  "",
].join("\n")

// A genuine reply: assistant output in scrollback, the composer settled EMPTY.
// The scrollback also echoes the past user prompt as a "›" row — only the LAST
// "›" row (the composer) may decide the verdict.
const replyScreen = [
  ">_ OpenAI Codex (v0.142.5)",
  "",
  "› reply with just: ok",
  "",
  "• ok",
  "",
  "› ",
  "",
].join("\n")

describe("codex promptNotAccepted", () => {
  const a = codex.New()

  test("composer still holding the sent text → swallowed", async () => {
    const s = await snap(swallowedScreen)
    const sent = (await snap(readyScreen)).text
    expect(a.promptNotAccepted(s, sent)).toBe(true)
  })

  test("screen byte-identical to the sent screen → swallowed", async () => {
    const s = await snap(readyScreen)
    expect(a.promptNotAccepted(s, s.text)).toBe(true)
  })

  test("assistant reply above an empty composer → accepted", async () => {
    const s = await snap(replyScreen)
    const sent = (await snap(readyScreen)).text
    expect(a.promptNotAccepted(s, sent)).toBe(false)
  })

  test("no composer row at all → not judged swallowed", async () => {
    const s = await snap(">_ OpenAI Codex (v0.142.5)\n\n  loading…")
    expect(a.promptNotAccepted(s, "something else")).toBe(false)
  })
})
