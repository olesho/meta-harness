// Cross-harness proof that historyWithSource's transcript-error fallback is
// harness-agnostic: a fresh-session ErrSessionNotFound degrades to store
// history, while a genuine reader failure (parse/corruption) rethrows rather
// than silently masking the problem. Not Pi-specific — driven via a generic
// adapter with a throwing readTranscript.

import { describe, expect, test } from "vitest"
import { Conversation } from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { generic, type Adapter } from "../../src/turns/index.ts"
import {
  RoleAssistant,
  HistorySourceStore,
  type Session,
  type Turn,
} from "../../src/chat/types.ts"
import { wrap } from "../../src/internal/async/index.ts"
import { ErrSessionNotFound } from "../../src/transcript/errors.ts"

/** A generic adapter whose readTranscript throws the supplied error. */
function throwingAdapter(err: unknown): Adapter {
  const a = generic.New() as Adapter & {
    readTranscript(id: string, wd: string): { role: string; text: string }[]
  }
  a.readTranscript = () => {
    throw err
  }
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
    text: "store reply",
    reason: "",
    startedAt: new Date(),
    completedAt: new Date(),
    httpCode: 0,
    retryAfter: 0,
  }
  await store.appendTurn(turn)
  return store
}

const session: Session = {
  id: "s1",
  harness: "codex",
  workingDir: "",
  createdAt: new Date(),
  harnessSessionID: "harness-uuid",
}

describe("historyWithSource transcript-error fallback", () => {
  test("ErrSessionNotFound degrades to store history", async () => {
    const store = await seed(session)
    const c = new Conversation({
      store,
      session,
      adapter: throwingAdapter(wrap("no file", ErrSessionNotFound)),
    })
    const [out, src] = await c.historyWithSource()
    expect(src).toBe(HistorySourceStore)
    expect(out.map((t) => t.text)).toEqual(["store reply"])
  })

  test("a non-sentinel reader error rethrows", async () => {
    const store = await seed(session)
    const boom = new Error("corrupt transcript line 42")
    const c = new Conversation({
      store,
      session,
      adapter: throwingAdapter(boom),
    })
    await expect(c.historyWithSource()).rejects.toThrow("corrupt transcript line 42")
  })
})
