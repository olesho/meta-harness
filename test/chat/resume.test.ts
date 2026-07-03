// Resume-launch: Open injects the harness-specific resume args and seeds the
// session's harnessSessionID. Complements the adapter-level resumeArgs unit
// tests (test/turns/**) by driving the wiring through the public Open path.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Open, newMemStore, type Conversation } from "../../src/chat/index.ts"
import { ErrResumeUnsupported, isSentinel } from "../../src/chat/errors.ts"
import { Context } from "../../src/internal/async/index.ts"
import { New, openFake } from "./fakeharness.ts"

const open = new Set<Conversation>()
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(ctx)
  }
  open.clear()
})

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return undefined
  } catch (e) {
    return e
  }
}

// Poll for the fake harness's argv-dump file (written at process startup).
function readArgv(path: string, timeoutMs = 2000): string[] {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"))
    if (Date.now() > deadline) throw new Error(`argv dump not written: ${path}`)
    // Tight spin; the file lands within the first frame's delay.
  }
}

describe("resume-launch", () => {
  test("Open rejects a harness that cannot resume", async () => {
    const err = await caught(
      Open(undefined, {
        harness: "gemini", // GeminiAdapter implements no SessionResumer
        binaryPath: "/nonexistent/harness",
        store: newMemStore(),
        resume: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    )
    expect(isSentinel(err, ErrResumeUnsupported)).toBe(true)
  })

  test("claude-code injects --resume and seeds harnessSessionID", async () => {
    const hintID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const resumeID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    const argvOut = join(mkdtempSync(join(tmpdir(), "resume-argv-")), "argv.json")
    const store = newMemStore()

    // The script paints a resume hint carrying hintID; the seed must win.
    const script = New("claude-code").Session(hintID).Idle().Build()
    const conv = await openFake(script, { resume: resumeID, argvOut, store, args: ["--model", "opus"] })
    open.add(conv)

    // The resume flag is appended after the caller's own args.
    const argv = readArgv(argvOut)
    expect(argv).toEqual(["--model", "opus", "--resume", resumeID])

    // harnessSessionID is seeded with the resume id, not the on-screen hint id.
    const sess = await store.getSession(conv.sessionID())
    expect(sess.harnessSessionID).toBe(resumeID)
  })
})
