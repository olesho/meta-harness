// Resume session-id fork handling — the scoped, one-time provisional refresh of
// a seeded harness session id (META-HARNESS-17).
//
// Codex 0.142.5 was empirically verified to CONTINUE the same session id across
// `codex resume <uuid>` (no fork); see CodexAdapter.locateSessionID. These tests
// therefore exercise the generic mechanism directly: the provisional latch on a
// Conversation drives the one-shot disk-locate refresh, while non-forking /
// non-resume sessions keep strict first-write-wins.
import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Conversation,
  adapterResumeForks,
} from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { newScreen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import type { Adapter } from "../../src/turns/types.ts"
import { type Session } from "../../src/chat/types.ts"

const tmps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "chat-resume-fork-"))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Writes a Codex rollout whose first line is the session_meta envelope, with an
// explicit mtime so locateLatestSession's newest-wins ordering is deterministic.
function writeCodexRollout(
  sessionsRoot: string,
  sessionID: string,
  cwd: string,
  mtimeSec: number,
): void {
  const dir = join(sessionsRoot, "2026", "07", "03")
  mkdirSync(dir, { recursive: true })
  const body =
    JSON.stringify({
      timestamp: "2026-07-03T05:25:23.303Z",
      type: "session_meta",
      payload: { session_id: sessionID, cwd, cli_version: "0.142.5" },
    }) + "\n"
  const path = join(dir, `rollout-2026-07-03T07-25-23-${sessionID}.jsonl`)
  writeFileSync(path, body)
  utimesSync(path, mtimeSec, mtimeSec)
}

describe("resume session-id fork refresh", () => {
  test("provisional latch refreshes the seeded id to the newest forked rollout, once", async () => {
    const cwd = tempDir()
    const sessionsRoot = tempDir()
    const oldUUID = "019f0100-0000-7013-a43a-000000000001"
    const forkedUUID = "019f0200-0000-7013-a43a-000000000002"
    // Old (pre-resume) rollout is older; the forked rollout is newest.
    writeCodexRollout(sessionsRoot, oldUUID, cwd, 1_000_000)
    writeCodexRollout(sessionsRoot, forkedUUID, cwd, 2_000_000)

    const adapter = codex.New()
    adapter.sessionsRoot = sessionsRoot

    const store = newMemStore()
    const sess: Session = {
      id: "chat-resume-fork",
      harness: "codex",
      workingDir: cwd,
      createdAt: new Date(),
      harnessSessionID: oldUUID, // seeded from the resume id
    }
    await store.createSession(sess)

    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    c.harnessSessionIDProvisional = true // armed by Open on a forking resume

    c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(forkedUUID)
    expect(c.harnessSessionIDProvisional).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(forkedUUID)

    // A second, even-newer rollout must NOT overwrite again — the latch is spent.
    writeCodexRollout(sessionsRoot, "019f0300-0000-7013-a43a-000000000003", cwd, 3_000_000)
    c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(forkedUUID)
  })

  test("without the provisional latch, a newer unrelated rollout never overwrites a captured id", async () => {
    const cwd = tempDir()
    const sessionsRoot = tempDir()
    const captured = "019f0400-0000-7013-a43a-000000000004"
    const intruder = "019f0500-0000-7013-a43a-000000000005"
    writeCodexRollout(sessionsRoot, captured, cwd, 1_000_000)
    writeCodexRollout(sessionsRoot, intruder, cwd, 9_000_000) // newer, but unrelated

    const adapter = codex.New()
    adapter.sessionsRoot = sessionsRoot

    const store = newMemStore()
    const sess: Session = {
      id: "chat-no-latch",
      harness: "codex",
      workingDir: cwd,
      createdAt: new Date(),
      harnessSessionID: captured,
    }
    await store.createSession(sess)

    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    // provisional NOT set — normal, non-resume session.

    c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(captured)
  })

  test("non-forking adapter: adapterResumeForks is false and the latch never arms", async () => {
    // Codex (real adapter) omits/returns-false, so the probe is false and the
    // provisional latch stays disarmed — the seeded id is preserved.
    expect(adapterResumeForks(codex.New())).toBe(false)

    // A resumed session for a non-forking harness keeps its seeded id even though
    // a newer rollout exists on disk, because the latch never arms.
    const cwd = tempDir()
    const sessionsRoot = tempDir()
    const seeded = "019f0600-0000-7013-a43a-000000000006"
    writeCodexRollout(sessionsRoot, "019f0700-0000-7013-a43a-000000000007", cwd, 9_000_000)

    const adapter = codex.New()
    adapter.sessionsRoot = sessionsRoot
    const store = newMemStore()
    const sess: Session = {
      id: "chat-nonfork",
      harness: "codex",
      workingDir: cwd,
      createdAt: new Date(),
      harnessSessionID: seeded,
    }
    await store.createSession(sess)
    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    // Mirror Open's arming decision for a non-forking adapter: stays disarmed.
    if (adapterResumeForks(adapter)) c.harnessSessionIDProvisional = true

    c.maybeExtractSessionID()
    expect(c.harnessSessionIDProvisional).toBe(false)
    expect(c.session.harnessSessionID).toBe(seeded)
  })

  test("a forking adapter arms the latch via adapterResumeForks", () => {
    // Structural capability probe: an adapter that reports the fork is detected.
    const forking = {
      name: () => "forking",
      onScreen: () => [],
      onWrapperStatus: () => [],
      resumeForksSessionID: () => true,
    } as unknown as Adapter
    expect(adapterResumeForks(forking)).toBe(true)
  })
})
