// Reads Codex CLI session transcripts. Codex writes one JSONL per session at:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<session-uuid>.jsonl
// Ported from harness-wrapper's codex/codex.go.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { wrap } from "../../internal/async/index.ts"
import { ErrEmptySessionID, ErrSessionNotFound } from "../errors.ts"
import type { Event } from "../event.ts"
import { locateLatestSession, walkJSONL } from "./locate.ts"
import { events } from "./parseCodex.ts"

export class CodexReader {
  // sessionsRoot overrides the default ~/.codex/sessions/ location.
  sessionsRoot: string

  constructor(sessionsRoot = "") {
    this.sessionsRoot = sessionsRoot
  }

  // read returns the canonical Event stream for the given Codex session UUID.
  // workingDir is ignored — Codex indexes by date/UUID, not working directory.
  read(harnessSessionID: string, _workingDir = ""): Event[] {
    if (harnessSessionID === "") {
      throw wrap("codex transcript: empty session id", ErrEmptySessionID)
    }
    const file = this.locate(harnessSessionID)
    return parseJSONL(file)
  }

  // locateLatestSession is the disk-based fallback used when the screen-scrape
  // session-id extractor finds nothing (Codex 0.142+).
  locateLatestSession(workingDir: string): string | undefined {
    return locateLatestSession(this.resolveRoot(), workingDir)
  }

  resolveRoot(): string {
    if (this.sessionsRoot !== "") return this.sessionsRoot
    return path.join(homedir(), ".codex", "sessions")
  }

  // locate scans the sessions root for a file whose name ends with the session
  // UUID suffix (rollout-<timestamp>-<uuid>.jsonl).
  private locate(sessionID: string): string {
    const root = this.resolveRoot()
    const suffix = "-" + sessionID + ".jsonl"
    for (const p of walkJSONL(root)) {
      if (path.basename(p).endsWith(suffix)) return p
    }
    throw wrap(
      `codex transcript: no session file for ${sessionID} under ${root}`,
      ErrSessionNotFound,
    )
  }
}

function parseJSONL(p: string): Event[] {
  let data: string
  try {
    data = readFileSync(p, "utf8")
  } catch (err) {
    throw wrap(`codex transcript: open ${p}`, err)
  }
  return events(data)
}
