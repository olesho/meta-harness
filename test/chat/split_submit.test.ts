// META-HARNESS-21: codex 0.142.5 consumes a text+Enter burst arriving in one
// PTY write as a paste — the Enter renders as a newline and the prompt never
// submits (deterministically after the /status prime). Send must therefore
// write the message text and the submit key as TWO separate stdin writes, with
// the submit gated on the composer echoing the text (bounded; on deadline the
// submit is written anyway). Uses the writeStdin test seam plus a real Screen
// fed by the test, so the echo gate is observed end to end without a PTY.

import { describe, expect, test } from "vitest"

import { Conversation, EventBus } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/index.ts"
import { Context, ctxDeadlineExceeded, isSentinel } from "../../src/internal/async/index.ts"
import { newScreen, type Screen } from "../../src/screen/index.ts"
import type { InputRequest as TurnsInputRequest } from "../../src/turns/index.ts"

const dec = new TextDecoder()
const csi13u = "\x1b[13u"

/** Records each writeStdin call as its own chunk (KeyRecorder concatenates). */
class ChunkRecorder {
  chunks: string[] = []
  onChunk: ((text: string, index: number) => void) | null = null
  write = (p: Uint8Array): void => {
    const text = dec.decode(p)
    this.chunks.push(text)
    this.onChunk?.(text, this.chunks.length - 1)
  }
}

/** A ready codex composer screen: an empty "› " prompt row. */
async function readyCodexScreen(): Promise<Screen> {
  const scr = newScreen(120, 10)
  await scr.write("\x1b[2J\x1b[HCodex\r\n\r\n› \r\n")
  return scr
}

async function newSendConv(
  harness: string,
  screen: Screen,
  rec: ChunkRecorder,
  echoBound: number,
): Promise<Conversation> {
  const store = newMemStore()
  const conv = new Conversation({
    opts: { harness, binaryPath: "unused", store, echoBound },
    store,
    screen,
    eventCh: new EventBus(8),
    writeStdin: rec.write,
  })
  await store.createSession({ ...conv.session })
  await conv.acquireControl(Context.background()) // hold control for send()
  return conv
}

describe("send: echo-gated split submit", () => {
  test("codex: text and submit are separate writes; submit follows the echo", async () => {
    const scr = await readyCodexScreen()
    const rec = new ChunkRecorder()
    // Bound far above the test's runtime so a pass proves the echo gate fired,
    // not the deadline fallback.
    const conv = await newSendConv("codex", scr, rec, 10_000)

    const prompt = "reply with just: ok"
    rec.onChunk = (text, i) => {
      // Echo the typed text into the composer only after the FIRST write, the
      // way the real TUI does. The submit key must not have been written yet.
      if (i === 0) {
        expect(text).toBe(prompt)
        void scr.write("\x1b[2J\x1b[HCodex\r\n\r\n› " + prompt + "\r\n")
      }
    }

    const started = Date.now()
    await conv.send(Context.background(), prompt)
    const elapsed = Date.now() - started

    expect(rec.chunks).toEqual([prompt, csi13u])
    // Echo-gated, not deadline-gated: resolves in ms, far under bound/2.
    expect(elapsed).toBeLessThan(2000)
  })

  test("codex: no echo → submit still written once the bound expires", async () => {
    const scr = await readyCodexScreen()
    const rec = new ChunkRecorder()
    const conv = await newSendConv("codex", scr, rec, 120)

    const started = Date.now()
    await conv.send(Context.background(), "swallowed anyway")
    const elapsed = Date.now() - started

    expect(rec.chunks).toEqual(["swallowed anyway", csi13u])
    expect(elapsed).toBeGreaterThanOrEqual(100) // waited out the echo bound
  })

  test("codex: changed-screen fallback past the halfway mark", async () => {
    const scr = await readyCodexScreen()
    const rec = new ChunkRecorder()
    const conv = await newSendConv("codex", scr, rec, 1000)

    rec.onChunk = (_text, i) => {
      if (i === 0) {
        // The TUI transforms the echo (paste placeholder) — the needle never
        // appears, but the screen changes; past bound/2 that must suffice.
        void scr.write("\x1b[2J\x1b[HCodex\r\n\r\n› [Pasted text #1]\r\n")
      }
    }

    const started = Date.now()
    await conv.send(Context.background(), "a prompt the composer never echoes verbatim")
    const elapsed = Date.now() - started

    expect(rec.chunks[1]).toBe(csi13u)
    expect(elapsed).toBeGreaterThanOrEqual(450) // waited for the halfway mark
    expect(elapsed).toBeLessThan(950) // but NOT for the full deadline
  })

  test("run ctx expiring during the echo wait rejects send with the deadline", async () => {
    // META-HARNESS-26: the local echo bound degrades gracefully, but the
    // run-level ctx must NOT — a hung harness that never echoes would
    // otherwise let a buffered errored-turn event outrace the deadline
    // classification downstream (run CLI exit 1 instead of 124).
    const scr = await readyCodexScreen()
    const rec = new ChunkRecorder()
    // Echo bound far beyond the ctx deadline: only the ctx can end the wait.
    const conv = await newSendConv("codex", scr, rec, 10_000)

    const { ctx, cancel } = Context.withDeadline(Context.background(), 100)
    try {
      const err = await conv.send(ctx, "never echoed").then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(isSentinel(err, ctxDeadlineExceeded)).toBe(true)
      // The text went out, but the submit key must not have been written.
      expect(rec.chunks).toEqual(["never echoed"])
    } finally {
      cancel()
    }
  })

  test("non-readiness harness keeps the single-burst write", async () => {
    const scr = newScreen(120, 10)
    await scr.write("anything\r\n")
    const rec = new ChunkRecorder()
    const conv = await newSendConv("generic", scr, rec, 120)

    await conv.send(Context.background(), "hello")
    expect(rec.chunks).toEqual(["hello\n"])
  })
})

describe("answer: free-text uses the same split submit", () => {
  test("codex free-text answer writes text, then submit after the echo", async () => {
    const scr = await readyCodexScreen()
    const rec = new ChunkRecorder()
    const conv = await newSendConv("codex", scr, rec, 10_000)

    const req: TurnsInputRequest = {
      id: "req-1",
      kind: "free_text",
      prompt: "Name?",
    }
    conv.currentInput = req

    rec.onChunk = (text, i) => {
      if (i === 0) void scr.write("\x1b[2J\x1b[HCodex\r\n\r\n› " + text + "\r\n")
    }

    await conv.answer(Context.background(), "req-1", { text: "Ada" })
    expect(rec.chunks).toEqual(["Ada", csi13u])
  })
})
