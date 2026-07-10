// Port of pkg/chat/history_source_test.go — HistoryWithSource provenance.
import { describe, expect, test } from "vitest"
import { Conversation } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { generic, type Adapter } from "../../src/turns/index.ts"
import {
  RoleAssistant,
  HistorySourceStore,
  HistorySourceTranscript,
  type Session,
  type Turn,
} from "../../src/chat/types.ts"

/** A generic adapter that also implements turns.TranscriptReader. */
function transcriptAdapter(turns: { role: string; text: string }[]): Adapter {
  const a = generic.New() as Adapter & {
    readTranscript(id: string, wd: string): { role: string; text: string }[]
  }
  a.readTranscript = () => turns
  return a
}

async function seed(sess: Session): Promise<ReturnType<typeof newMemStore>> {
  const store = newMemStore()
  await store.createSession(sess)
  const turn: Turn = {
    id: "t1",
    sessionID: sess.id,
    role: RoleAssistant,
    state: "complete",
    text: "screen tail",
    reason: "",
    startedAt: new Date(),
    completedAt: new Date(),
    httpCode: 0,
    retryAfter: 0,
  }
  await store.appendTurn(turn)
  return store
}

const baseSession = (over: Partial<Session>): Session => ({
  id: "s1",
  harness: "",
  workingDir: "",
  createdAt: new Date(),
  harnessSessionID: "",
  ...over,
})

describe("HistoryWithSource", () => {
  test("store fallback when no harness session id", async () => {
    const sess = baseSession({})
    const store = await seed(sess)
    const c = new Conversation({
      store,
      session: sess,
      adapter: transcriptAdapter([{ role: "assistant", text: "transcript" }]),
    })
    const [out, src] = await c.historyWithSource()
    expect(src).toBe(HistorySourceStore)
    expect(out.length).toBe(1)
    expect(out[0]!.text).toBe("screen tail")
  })

  test("transcript when reader + session id present", async () => {
    const sess = baseSession({ harnessSessionID: "harness-uuid" })
    const store = await seed(sess)
    const c = new Conversation({
      store,
      session: sess,
      adapter: transcriptAdapter([{ role: "assistant", text: "full transcript reply" }]),
    })
    const [out, src] = await c.historyWithSource()
    expect(src).toBe(HistorySourceTranscript)
    expect(out.length).toBe(1)
    expect(out[0]!.text).toBe("full transcript reply")
  })
})
