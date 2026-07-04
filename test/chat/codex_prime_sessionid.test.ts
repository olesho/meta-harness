// Startup session-id prime via the Codex /status scrape (META-HARNESS-20).
//
// These drive Conversation.primeSessionID directly (a private method reached via
// a bracket escape) with an injected writeStdin that simulates how Codex renders
// the /status box in response to the primer's keystrokes — no disk, no PTY.
import { describe, expect, test } from "bun:test"
import { Conversation } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { newScreen, type Screen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import { Context } from "../../src/internal/async/index.ts"
import { type Session } from "../../src/chat/types.ts"

const READY = "Codex\r\n\r\n› \r\n"

// A wide /status box (>= CODEX_STATUS_MIN_COLS) carrying the session id.
function statusBox(uuid: string): string {
  return (
    "\x1b[H\x1b[2J" +
    "╭────────────────────────────────────────────────────────────╮\r\n" +
    "│ >_ OpenAI Codex (v0.142.5)                                   │\r\n" +
    "│ Session:  " + uuid + "                 │\r\n" +
    "╰────────────────────────────────────────────────────────────╯\r\n" +
    "› \r\n"
  )
}

function primeOutcomeOf(c: Conversation): string | undefined {
  return (c as unknown as { primeOutcome?: string }).primeOutcome
}

interface Built {
  c: Conversation
  scr: Screen
  store: ReturnType<typeof newMemStore>
  sess: Session
  sent: string[]
}

async function build(opts: {
  cols?: number
  primeBound?: number
  initial?: string
  onStatus?: (scr: Screen, count: number, sent: string[]) => void
}): Promise<Built> {
  const scr = newScreen(opts.cols ?? 120, 40)
  const store = newMemStore()
  const sess: Session = {
    id: "prime-" + Math.floor(performance.now() * 1000),
    harness: "codex",
    workingDir: "/work",
    createdAt: new Date(),
    harnessSessionID: "",
  }
  const sent: string[] = []
  const c = new Conversation({
    opts: {
      harness: "codex",
      cols: opts.cols ?? 120,
      rows: 40,
      primeBound: opts.primeBound ?? 300,
    },
    adapter: codex.New(),
    screen: scr,
    store,
    session: { ...sess },
    writeStdin: (p) => {
      const s = new TextDecoder().decode(p)
      sent.push(s)
      if (s.includes("/status") && opts.onStatus) {
        const count = sent.filter((x) => x.includes("/status")).length
        opts.onStatus(scr, count, sent)
      }
    },
  })
  await store.createSession({ ...sess })
  return { c, scr, store, sess, sent }
}

function statusCount(sent: string[]): number {
  return sent.filter((s) => s.includes("/status")).length
}

describe("codex session-id prime", () => {
  test("happy path: captures from a simulated /status render, no disk", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"
    const { c, scr } = await build({
      initial: READY,
      onStatus: (s) => void s.write(statusBox(uuid)),
    })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect(c.session.harnessSessionID).toBe(uuid)
    expect(primeOutcomeOf(c)).toBe("captured")
  })

  test("persisted before return: the store already holds the id", async () => {
    const uuid = "019f0287-aaaa-7013-a43a-4eb1f65d94f1"
    const { c, scr, store, sess } = await build({
      onStatus: (s) => void s.write(statusBox(uuid)),
    })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid)
  })

  test("resend fires at most once when the first render is delayed", async () => {
    const uuid = "019f0300-0000-7013-a43a-000000000003"
    // First /status renders nothing (delayed); the halfway resend renders the box.
    const { c, scr, sent } = await build({
      primeBound: 200,
      onStatus: (s, count) => {
        if (count >= 2) void s.write(statusBox(uuid))
      },
    })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect(c.session.harnessSessionID).toBe(uuid)
    expect(statusCount(sent)).toBe(2) // exactly one resend, no third send
    expect(primeOutcomeOf(c)).toBe("captured")
  })

  test("anchored: a Session:-shaped string in prose is not mis-captured", async () => {
    const boxUUID = "019f0400-0000-7013-a43a-000000000004"
    const proseUUID = "019f0999-9999-7013-a43a-999999999999"
    const { c, scr } = await build({
      onStatus: (s) => void s.write(statusBox(boxUUID)),
    })
    // Reply prose mentions a Session: <uuid> string with no box signature.
    await scr.write("Log says: Session: " + proseUUID + " opened.\r\n› \r\n")
    await c["primeSessionID"](Context.background())
    expect(c.session.harnessSessionID).toBe(boxUUID)
  })

  test("small terminal: too_narrow, no write, id stays empty", async () => {
    const { c, scr, sent } = await build({ cols: 40 })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect(primeOutcomeOf(c)).toBe("too_narrow")
    expect(sent.length).toBe(0)
    expect(c.session.harnessSessionID).toBe("")
  })

  test("written but not captured: does not throw, id empty", async () => {
    // /status is written but the box never renders within the bound.
    const { c, scr, sent } = await build({ primeBound: 120, onStatus: () => {} })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect(c.session.harnessSessionID).toBe("")
    expect(primeOutcomeOf(c)).toBe("written_uncaptured")
    expect(statusCount(sent)).toBeGreaterThanOrEqual(1)
  })

  test("not written: prompt never ready, no write, no false capture", async () => {
    // No "› " so the composer is never ready; the write is skipped.
    const { c, scr, sent } = await build({ primeBound: 100 })
    await scr.write("Codex starting…\r\n")
    await c["primeSessionID"](Context.background())
    expect(primeOutcomeOf(c)).toBe("not_written")
    expect(sent.length).toBe(0)
    expect(c.session.harnessSessionID).toBe("")
  })

  test("cancellation mid-prime rejects with ctx.err()", async () => {
    const { c, scr } = await build({ primeBound: 5000 })
    // Never ready → the primer blocks awaiting readiness.
    await scr.write("Codex starting…\r\n")
    const { ctx, cancel } = Context.withCancel(Context.background())
    const p = c["primeSessionID"](ctx)
    cancel()
    await expect(p).rejects.toBe(ctx.err())
  })

  test("ErrClosed mid-prime is fatal", async () => {
    const { c, scr } = await build({ primeBound: 5000 })
    await scr.write("Codex starting…\r\n")
    const p = c["primeSessionID"](Context.background())
    await c.close()
    await expect(p).rejects.toBeDefined()
  })

  test("no leaked subscription after a deadline miss", async () => {
    const { c, scr } = await build({ primeBound: 100, onStatus: () => {} })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    const subs = (scr as unknown as { subs: Set<unknown> }).subs
    expect(subs.size).toBe(0)
  })

  test("no deadlock: awaitPromptReady resolves after a prime", async () => {
    const uuid = "019f0500-0000-7013-a43a-000000000005"
    const { c, scr } = await build({ onStatus: (s) => void s.write(statusBox(uuid)) })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    // The composer is ready; a follow-up readiness wait must not hang.
    await c["awaitPromptReady"](Context.background())
    expect(true).toBe(true)
  })

  test("race: two sessions sharing a workingDir each capture their own id", async () => {
    const uuidA = "019f0aaa-0000-7013-a43a-00000000000a"
    const uuidB = "019f0bbb-0000-7013-a43a-00000000000b"
    const a = await build({ onStatus: (s) => void s.write(statusBox(uuidA)) })
    const b = await build({ onStatus: (s) => void s.write(statusBox(uuidB)) })
    await a.scr.write(READY)
    await b.scr.write(READY)
    await Promise.all([
      a.c["primeSessionID"](Context.background()),
      b.c["primeSessionID"](Context.background()),
    ])
    expect(a.c.session.harnessSessionID).toBe(uuidA)
    expect(b.c.session.harnessSessionID).toBe(uuidB)
  })

  test("first TurnComplete recaptures a written-but-missed box from scrollback", async () => {
    const uuid = "019f0c0c-0000-7013-a43a-00000000000c"
    const { c, scr } = await build({ primeBound: 80, onStatus: () => {} })
    await scr.write(READY)
    await c["primeSessionID"](Context.background())
    expect(c.session.harnessSessionID).toBe("")
    // The box lands later; the TurnComplete-path capture picks it up.
    await scr.write(statusBox(uuid))
    await c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(uuid)
  })
})
