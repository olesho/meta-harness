// Codex 0.142 session-id capture via the own-output /status scrape (replacing
// the removed disk-locate fallback), exercised in both the direct-extract and
// idle-completion paths.
import { describe, expect, test } from "bun:test"
import { Conversation, EventBus, Signal } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { newScreen, type Screen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import {
  RoleAssistant,
  TurnStateStreaming,
  TurnStateComplete,
  type Session,
  type Turn,
} from "../../src/chat/types.ts"

// Renders a /status box carrying the session id, as Codex draws it after the
// `/status` slash command.
async function writeStatusBox(scr: Screen, uuid: string): Promise<void> {
  await scr.write(
    "\x1b[H\x1b[2J" +
      "╭──────────────────────────────────────────────────────────╮\r\n" +
      "│ >_ OpenAI Codex (v0.142.5)                                 │\r\n" +
      "│ Session:  " + uuid + "               │\r\n" +
      "╰──────────────────────────────────────────────────────────╯\r\n" +
      "› \r\n",
  )
}

describe("session-id /status capture", () => {
  test("maybeExtractSessionID captures + persists from the /status box", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"
    const scr = newScreen(120, 40)
    await writeStatusBox(scr, uuid)

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
      opts: { harness: "codex" },
      adapter: codex.New(),
      screen: scr,
      store,
      session: { ...sess },
    })

    await c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(uuid)
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid)
  })

  test("maybeIdleComplete captures the codex session id from the screen", async () => {
    const uuid = "019f0287-aaaa-7013-a43a-4eb1f65d94f1"
    const scr = newScreen(120, 40)
    // The /quit hint is a captured own-output signal too; use it here so the same
    // screen is both idle (has the prompt) and carries the id.
    await scr.write(
      "Codex\r\n\r\nDone — committed the change.\r\n" +
        "To continue this session, run codex resume " + uuid + "\r\n› \r\n",
    )

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

    const c = new Conversation({
      opts: { harness: "codex" },
      store,
      adapter: codex.New(),
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
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid)
  })
})
