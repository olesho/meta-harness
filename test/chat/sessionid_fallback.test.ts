// Port of pkg/chat/sessionid_fallback_test.go — Codex 0.142 on-disk session-id
// recovery via the screen-blind disk locator, in both the direct-extract and
// idle-completion paths.
import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Conversation, EventBus, Signal } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { newScreen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import {
  RoleAssistant,
  TurnStateStreaming,
  TurnStateComplete,
  type Session,
  type Turn,
} from "../../src/chat/types.ts"

const tmps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "chat-sid-"))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function writeCodexRollout(sessionsRoot: string, sessionID: string, cwd: string): void {
  const dir = join(sessionsRoot, "2026", "06", "26")
  mkdirSync(dir, { recursive: true })
  const body =
    JSON.stringify({
      timestamp: "2026-06-26T05:25:23.303Z",
      type: "session_meta",
      payload: { session_id: sessionID, cwd, cli_version: "0.142.0" },
    }) + "\n"
  writeFileSync(join(dir, `rollout-2026-06-26T07-25-23-${sessionID}.jsonl`), body)
}

describe("session-id disk fallback", () => {
  test("maybeExtractSessionID recovers + persists from disk", async () => {
    const cwd = tempDir()
    const sessionsRoot = tempDir()
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"
    writeCodexRollout(sessionsRoot, uuid, cwd)

    const adapter = codex.New()
    adapter.sessionsRoot = sessionsRoot

    const store = newMemStore()
    const sess: Session = {
      id: "chat-sess-codex",
      harness: "codex",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: "",
    }
    await store.createSession(sess)

    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })

    c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(uuid)
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid)
  })

  test("maybeIdleComplete recovers codex session id from disk", async () => {
    const cwd = tempDir()
    const sessionsRoot = tempDir()
    const uuid = "019f0287-aaaa-7013-a43a-4eb1f65d94f1"
    writeCodexRollout(sessionsRoot, uuid, cwd)

    const adapter = codex.New()
    adapter.sessionsRoot = sessionsRoot

    const store = newMemStore()
    const sess: Session = {
      id: "idle-codex",
      harness: "",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: "",
    }
    await store.createSession(sess)
    const turn: Turn = {
      id: "turn-1",
      sessionID: sess.id,
      role: RoleAssistant,
      state: TurnStateStreaming,
      text: "",
      reason: "",
      startedAt: new Date(Date.now() - 30000),
      completedAt: new Date(0),
      httpCode: 0,
      retryAfter: 0,
    }
    await store.appendTurn(turn)

    const scr = newScreen(120, 40)
    await scr.write("Codex\n\nDone — committed the change.\n\n› \n")

    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      store,
      adapter,
      screen: scr,
      session: { ...sess },
      eventCh: new EventBus(4),
      markerArmCh: new Signal(),
      currentTurn: turn,
    })

    await c.maybeIdleComplete()
    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.turn!.state).toBe(TurnStateComplete)
    expect(c.session.harnessSessionID).toBe(uuid)
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid)
  })
})
