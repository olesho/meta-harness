// Resume plumbing (Options.resume) and the Reopen convenience helper, driven
// over a REAL fake-harness process. Phase 1 asserts the adapter's resume args
// are prepended to argv and the harness session id is seeded; Phase 2 asserts
// Reopen reuses the SAME chat session id, relaunches in resume mode, and reads
// back the stored session's history — and that both surface the right sentinels.

import { afterEach, describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Context } from "../../src/internal/async/index.ts"
import { isSentinel } from "../../src/internal/async/index.ts"
import {
  Open,
  Reopen,
  ErrResumeUnsupported,
  ErrNoHarnessSession,
  newMemStore,
  RoleAssistant,
  TurnStateComplete,
  type Conversation,
  type Session,
  type Turn,
} from "../../src/chat/index.ts"
import {
  New,
  fakeHarnessBin,
  fakeLaunchEnv,
  openFake,
  testIdleGap,
  testMarkerGap,
} from "./fakeharness.ts"

const open = new Set<Conversation>()
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(ctx)
  }
  open.clear()
})
function track(conv: Conversation): Conversation {
  open.add(conv)
  return conv
}

function argvOutPath(): string {
  return join(mkdtempSync(join(tmpdir(), "fakeharness-argv-")), "argv.json")
}

// Polls the argv-dump file the fake writes at startup; the write races the Open
// return, so retry briefly before reading.
async function readArgv(path: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw new Error(`argv dump never appeared at ${path}`)
}

const uuid = "11111111-2222-3333-4444-555555555555"

describe("resume plumbing (Phase 1)", () => {
  test("Open with resume prepends claude-code resume args + seeds harnessSessionID", async () => {
    const store = newMemStore()
    const argvPath = argvOutPath()
    const conv = track(
      await openFake(New("claude-code").Idle().Build(), {
        resume: uuid,
        store,
        argvOut: argvPath,
        args: ["--foo"],
      }),
    )
    const argv = await readArgv(argvPath)
    expect(argv.slice(0, 2)).toEqual(["--resume", uuid])
    expect(argv).toContain("--foo")
    // resumeArgs must precede the caller's own args.
    expect(argv.indexOf("--resume")).toBeLessThan(argv.indexOf("--foo"))

    const stored = await store.getSession(conv.sessionID())
    expect(stored.harnessSessionID).toBe(uuid)
  })

  test("Open with resume prepends codex resume args", async () => {
    const argvPath = argvOutPath()
    track(
      await openFake(New("codex").Idle().Build(), {
        resume: uuid,
        argvOut: argvPath,
      }),
    )
    const argv = await readArgv(argvPath)
    expect(argv.slice(0, 2)).toEqual(["resume", uuid])
  })

  test("Open with resume against a non-resuming harness throws ErrResumeUnsupported", async () => {
    // opencode has no SessionResumer, so Open rejects before spawning.
    const p = Open(undefined, {
      harness: "opencode",
      binaryPath: fakeHarnessBin,
      store: newMemStore(),
      resume: uuid,
    })
    await expect(p).rejects.toThrow()
    await p.catch((err) => expect(isSentinel(err, ErrResumeUnsupported)).toBe(true))
  })
})

describe("Reopen helper (Phase 2)", () => {
  test("Reopen reuses the stored chat session id, resumes, and reads back history", async () => {
    const store = newMemStore()
    const storedID = "chat-sess-reopen"
    const workingDir = mkdtempSync(join(tmpdir(), "reopen-wd-"))
    const session: Session = {
      id: storedID,
      harness: "claude-code",
      workingDir,
      createdAt: new Date(),
      harnessSessionID: uuid,
    }
    await store.createSession(session)
    const prior: Turn = {
      id: "t1",
      sessionID: storedID,
      role: RoleAssistant,
      state: TurnStateComplete,
      text: "earlier reply",
      reason: "",
      startedAt: new Date(),
      completedAt: new Date(),
      httpCode: 0,
      retryAfter: 0,
    }
    await store.appendTurn(prior)

    const argvPath = argvOutPath()
    const conv = track(
      await Reopen(undefined, {
        sessionID: storedID,
        binaryPath: fakeHarnessBin,
        env: fakeLaunchEnv(New("claude-code").Idle().Build(), argvPath),
        store,
        cols: 120,
        rows: 40,
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    )

    // Same chat session id — not a freshly-minted one.
    expect(conv.sessionID()).toBe(storedID)

    const argv = await readArgv(argvPath)
    expect(argv.slice(0, 2)).toEqual(["--resume", uuid])

    // The prior turn is still reachable under the REUSED chat session id — the
    // proof that Reopen attached the stored Session rather than minting a new
    // one. Read via the store directly, independent of the transcript path.
    const turns = await store.listTurns(conv.sessionID())
    expect(turns.map((t) => t.text)).toContain("earlier reply")
  })

  test("Reopen throws ErrNoHarnessSession when the stored session has none", async () => {
    const store = newMemStore()
    const storedID = "chat-sess-empty"
    await store.createSession({
      id: storedID,
      harness: "claude-code",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: "",
    })
    const p = Reopen(undefined, {
      sessionID: storedID,
      binaryPath: fakeHarnessBin,
      store,
    })
    await expect(p).rejects.toThrow()
    await p.catch((err) => expect(isSentinel(err, ErrNoHarnessSession)).toBe(true))
  })

  test("Reopen propagates ErrResumeUnsupported for a non-resuming harness", async () => {
    const store = newMemStore()
    const storedID = "chat-sess-opencode"
    await store.createSession({
      id: storedID,
      harness: "opencode",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: uuid,
    })
    const p = Reopen(undefined, {
      sessionID: storedID,
      binaryPath: fakeHarnessBin,
      store,
    })
    await expect(p).rejects.toThrow()
    await p.catch((err) => expect(isSentinel(err, ErrResumeUnsupported)).toBe(true))
  })
})
