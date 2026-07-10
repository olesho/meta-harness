// Port of pkg/chat/api_error_test.go — structured api-error fields forwarded
// from a turns.Blocked event onto the emitted Turn.
import { describe, expect, test } from "vitest"
import { Conversation, EventBus } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { Blocked } from "../../src/turns/index.ts"
import {
  RoleAssistant,
  TurnStateStreaming,
  TurnStateErrored,
  type Session,
  type Turn,
} from "../../src/chat/types.ts"

function streamingTurn(sessionID: string): Turn {
  return {
    id: "turn-1",
    sessionID,
    role: RoleAssistant,
    state: TurnStateStreaming,
    text: "",
    reason: "",
    startedAt: new Date(),
    completedAt: new Date(0),
    httpCode: 0,
    retryAfter: 0,
  }
}

async function mkConv(sessionID: string): Promise<Conversation> {
  const store = newMemStore()
  const sess: Session = {
    id: sessionID,
    harness: "",
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  }
  await store.createSession(sess)
  const turn = streamingTurn(sessionID)
  await store.appendTurn(turn)
  return new Conversation({
    store,
    session: sess,
    eventCh: new EventBus(4),
    currentTurn: turn,
  })
}

describe("handleTurnsEvent api-error", () => {
  test("HTTPCode + RetryAfter forwarded on a Blocked event", async () => {
    const c = await mkConv("test-session")
    await c.handleTurnsEvent({
      kind: Blocked,
      at: new Date(),
      reason: "api error 529: Overloaded.",
      httpCode: 529,
      retryAfter: 30000,
    })
    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.err).toBeUndefined()
    expect(value!.turn!.state).toBe(TurnStateErrored)
    expect(value!.turn!.httpCode).toBe(529)
    expect(value!.turn!.retryAfter).toBe(30000)
    expect(value!.turn!.reason).toBe("api error 529: Overloaded.")
  })

  test("transport error (no code) still forwarded as Code=0", async () => {
    const c = await mkConv("transport-session")
    await c.handleTurnsEvent({
      kind: Blocked,
      at: new Date(),
      reason: "api error: The socket connection was closed unexpectedly.",
      httpCode: 0,
    })
    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.turn!.httpCode).toBe(0)
    expect(value!.turn!.retryAfter).toBe(0)
    expect(value!.turn!.state).toBe(TurnStateErrored)
  })
})
