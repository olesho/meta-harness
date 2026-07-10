// Resume session-id fork handling — the scoped, one-time provisional refresh of
// a seeded harness session id (META-HARNESS-17).
//
// Codex 0.142.5 was empirically verified to CONTINUE the same session id across
// `codex resume <uuid>` (no fork; CodexAdapter.resumeForksSessionID() === false).
// The generic provisional-refresh mechanism is retained for a hypothetical
// forking harness, so these tests drive it through a SYNTHETIC forking adapter
// that implements SessionIDLocator + resumeForksSessionID(): true — Codex no
// longer implements locateSessionID (its /status scrape replaced disk-locate).
import { describe, expect, test } from "vitest"
import {
  Conversation,
  adapterResumeForks,
} from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import { newScreen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import type { Adapter } from "../../src/turns/types.ts"
import { type Session } from "../../src/chat/types.ts"

// A synthetic adapter whose disk-locate is a controllable variable, standing in
// for a harness whose `resume` forks the session id onto a fresh rollout.
function forkingAdapter(located: { id: string }): Adapter {
  return {
    name: () => "forking",
    onScreen: () => [],
    onWrapperStatus: () => [],
    locateSessionID: () => (located.id ? [located.id, true] : ["", false]),
    resumeForksSessionID: () => true,
  } as unknown as Adapter
}

describe("resume session-id fork refresh", () => {
  test("provisional latch refreshes the seeded id to the newest forked id, once", async () => {
    const oldUUID = "019f0100-0000-7013-a43a-000000000001"
    const forkedUUID = "019f0200-0000-7013-a43a-000000000002"
    const located = { id: forkedUUID }

    const store = newMemStore()
    const sess: Session = {
      id: "chat-resume-fork",
      harness: "codex",
      workingDir: "/work",
      createdAt: new Date(),
      harnessSessionID: oldUUID, // seeded from the resume id
    }
    await store.createSession(sess)

    const c = new Conversation({
      opts: { harness: "codex", workingDir: "/work" },
      adapter: forkingAdapter(located),
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    c.harnessSessionIDProvisional = true // armed by Open on a forking resume

    await c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(forkedUUID)
    expect(c.harnessSessionIDProvisional).toBe(false)
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(forkedUUID)

    // A second, even-newer id must NOT overwrite again — the latch is spent.
    located.id = "019f0300-0000-7013-a43a-000000000003"
    await c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(forkedUUID)
  })

  test("without the provisional latch, a newer id never overwrites a captured id", async () => {
    const captured = "019f0400-0000-7013-a43a-000000000004"
    const located = { id: "019f0500-0000-7013-a43a-000000000005" }

    const store = newMemStore()
    const sess: Session = {
      id: "chat-no-latch",
      harness: "codex",
      workingDir: "/work",
      createdAt: new Date(),
      harnessSessionID: captured,
    }
    await store.createSession(sess)

    const c = new Conversation({
      opts: { harness: "codex", workingDir: "/work" },
      adapter: forkingAdapter(located),
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    // provisional NOT set — normal, non-resume session.

    await c.maybeExtractSessionID()
    expect(c.session.harnessSessionID).toBe(captured)
  })

  test("non-forking adapter: codex reports no fork and the latch never arms", async () => {
    // Codex (real adapter) returns false, so the probe is false and the
    // provisional latch stays disarmed — the seeded id is preserved.
    expect(adapterResumeForks(codex.New())).toBe(false)

    const seeded = "019f0600-0000-7013-a43a-000000000006"
    const adapter = codex.New()
    const store = newMemStore()
    const sess: Session = {
      id: "chat-nonfork",
      harness: "codex",
      workingDir: "/work",
      createdAt: new Date(),
      harnessSessionID: seeded,
    }
    await store.createSession(sess)
    const c = new Conversation({
      opts: { harness: "codex", workingDir: "/work" },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    })
    if (adapterResumeForks(adapter)) c.harnessSessionIDProvisional = true

    await c.maybeExtractSessionID()
    expect(c.harnessSessionIDProvisional).toBe(false)
    expect(c.session.harnessSessionID).toBe(seeded)
  })

  test("a forking adapter arms the latch via adapterResumeForks", () => {
    const forking = {
      name: () => "forking",
      onScreen: () => [],
      onWrapperStatus: () => [],
      resumeForksSessionID: () => true,
    } as unknown as Adapter
    expect(adapterResumeForks(forking)).toBe(true)
  })
})
