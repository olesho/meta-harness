// In-memory chat.Store implementation — the TS port of pkg/chat/memstore. Holds
// sessions and turns in process memory; everything is lost on restart. Suitable
// for testing, single-process gateways, and prototype use.
//
// JavaScript is single-threaded, so no explicit locking is needed; values are
// deep-copied on the way in and out to mirror Go's copy-on-store semantics.

import type { Store } from "./store.ts"
import type { Session, Turn } from "./types.ts"

function copySession(s: Session): Session {
  return { ...s, createdAt: new Date(s.createdAt) }
}

function copyTurn(t: Turn): Turn {
  return { ...t, startedAt: new Date(t.startedAt), completedAt: new Date(t.completedAt) }
}

/** The in-memory implementation of chat.Store. */
export class MemStore implements Store {
  private readonly sessions = new Map<string, Session>()
  private readonly turns = new Map<string, Turn[]>()

  async createSession(s: Session | null | undefined): Promise<void> {
    if (!s) throw new Error("memstore: nil session")
    if (this.sessions.has(s.id)) {
      throw new Error(`memstore: session ${s.id} already exists`)
    }
    this.sessions.set(s.id, copySession(s))
  }

  async getSession(id: string): Promise<Session> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`memstore: session ${id} not found`)
    return copySession(s)
  }

  async updateSession(s: Session | null | undefined): Promise<void> {
    if (!s) throw new Error("memstore: nil session")
    if (!this.sessions.has(s.id)) {
      throw new Error(`memstore: session ${s.id} not found`)
    }
    this.sessions.set(s.id, copySession(s))
  }

  async appendTurn(t: Turn | null | undefined): Promise<void> {
    if (!t) throw new Error("memstore: nil turn")
    if (!this.sessions.has(t.sessionID)) {
      throw new Error(`memstore: session ${t.sessionID} not found for turn ${t.id}`)
    }
    const list = this.turns.get(t.sessionID) ?? []
    list.push(copyTurn(t))
    this.turns.set(t.sessionID, list)
  }

  async updateTurn(t: Turn | null | undefined): Promise<void> {
    if (!t) throw new Error("memstore: nil turn")
    const list = this.turns.get(t.sessionID) ?? []
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.id === t.id) {
        list[i] = copyTurn(t)
        return
      }
    }
    throw new Error(`memstore: turn ${t.id} not found in session ${t.sessionID}`)
  }

  async listTurns(sessionID: string): Promise<Turn[]> {
    const list = this.turns.get(sessionID)
    if (!list) {
      if (!this.sessions.has(sessionID)) {
        throw new Error(`memstore: session ${sessionID} not found`)
      }
      return []
    }
    return list.map(copyTurn)
  }
}

/** Construct an empty MemStore. */
export function newMemStore(): MemStore {
  return new MemStore()
}
