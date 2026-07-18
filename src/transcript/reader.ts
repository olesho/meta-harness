// Reader reads a harness's persisted transcript for one session.
//
// harnessSessionID is the UUID the harness assigned to its own session.
// workingDir is the directory the chat session was opened in; some harnesses
// (Claude Code) index transcripts by working directory, so they need
// it; others (Codex) ignore it.

import type { Event } from "./event.ts";

export interface Reader {
  // read returns the canonical Event stream for a session. Throws for missing
  // files, malformed input, etc.
  read(harnessSessionID: string, workingDir: string): Event[];
}
