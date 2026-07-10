// Port of pkg/chat/quit_test.go — graceful quit sequence + raw session-id capture.
import { describe, expect, test } from "vitest"
import { Conversation } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { claudecode, generic } from "../../src/turns/index.ts"
import { ErrQuitUnsupported, ErrClosed, isSentinel } from "../../src/chat/errors.ts"
import { Context } from "../../src/internal/async/index.ts"
import type { Session } from "../../src/chat/types.ts"
import { KeyRecorder } from "./helpers.ts"

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return undefined
  } catch (e) {
    return e
  }
}

describe("Quit", () => {
  test("sends claude-code quit sequence through the held writer", async () => {
    const rec = new KeyRecorder()
    const c = new Conversation({
      opts: { harness: "claude-code" },
      adapter: claudecode.New(),
      writeStdin: rec.write,
    })
    await c.quit(Context.background())
    expect(rec.text()).toBe("/quit\x1b[13u")
  })

  test("unsupported adapter reports ErrQuitUnsupported and writes nothing", async () => {
    const rec = new KeyRecorder()
    const c = new Conversation({
      opts: { harness: "generic" },
      adapter: generic.New(),
      writeStdin: rec.write,
    })
    expect(isSentinel(await caught(c.quit(Context.background())), ErrQuitUnsupported)).toBe(true)
    expect(rec.data.length).toBe(0)
  })

  test("after close reports ErrClosed", async () => {
    const rec = new KeyRecorder()
    const c = new Conversation({
      opts: { harness: "claude-code" },
      adapter: claudecode.New(),
      writeStdin: rec.write,
      closed: true,
    })
    expect(isSentinel(await caught(c.quit(Context.background())), ErrClosed)).toBe(true)
  })
})

describe("captureRawSessionID", () => {
  test("captures + persists the resume hint; first capture wins", async () => {
    const id = "74ca2184-c064-492c-88dc-c79c128de13e"
    const store = newMemStore()
    const sess: Session = {
      id: "chat-sess-1",
      harness: "claude-code",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: "",
    }
    await store.createSession(sess)
    const c = new Conversation({
      opts: { harness: "claude-code" },
      adapter: claudecode.New(),
      store,
      session: { ...sess },
    })

    await c.captureRawSessionID("✻ Baked for 5s")
    expect(c.session.harnessSessionID).toBe("")

    // Persist-before-set: the in-memory id is committed only after the awaited
    // store write, so the store already reflects it here.
    await c.captureRawSessionID("claude --resume " + id + "\x1b[22m\r")
    expect(c.session.harnessSessionID).toBe(id)
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(id)

    await c.captureRawSessionID("claude --resume 00000000-0000-0000-0000-000000000000")
    expect(c.session.harnessSessionID).toBe(id)
  })
})
