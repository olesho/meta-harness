// Store — persists chat-level session metadata and turn records. The TS port of
// pkg/chat/store.go. Implementations must be safe for concurrent use.
//
// Store does NOT store transcript bodies; harnesses persist their own logs and
// the transcript layer reads them for History reconstruction.

import type { Session, Turn } from "./types.ts";

export interface Store {
  /** Insert a new session record. Errors if a session with the same id exists. */
  createSession(s: Session): Promise<void>;

  /** Return the session with the given id, or throw if not found. */
  getSession(id: string): Promise<Session>;

  /** Overwrite the stored record. Used to backfill harnessSessionID. */
  updateSession(s: Session): Promise<void>;

  /** Record a new turn. Implementations must preserve insertion order. */
  appendTurn(t: Turn): Promise<void>;

  /** Replace an existing turn record (the turn must already exist). */
  updateTurn(t: Turn): Promise<void>;

  /** Return every turn for the session in insertion order. */
  listTurns(sessionID: string): Promise<Turn[]>;
}
