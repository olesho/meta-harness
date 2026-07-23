// Reads Codex CLI session transcripts. Codex writes one JSONL per session at:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<session-uuid>.jsonl
// Ported from harness-wrapper's codex/codex.go.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { wrap } from "../../internal/async/index.ts";
import { ErrEmptySessionID, ErrSessionNotFound } from "../errors.ts";
import type { Event } from "../event.ts";
import { usageFromCodexJSONL, type Usage } from "../usage.ts";
import { locateLatestSession, walkJSONL } from "./locate.ts";
import { events } from "./parseCodex.ts";

export class CodexReader {
  // sessionsRoot overrides the default ~/.codex/sessions/ location.
  sessionsRoot: string;

  constructor(sessionsRoot = "") {
    this.sessionsRoot = sessionsRoot;
  }

  // read returns the canonical Event stream for the given Codex session UUID.
  // workingDir is ignored — Codex indexes by date/UUID, not working directory.
  read(harnessSessionID: string, _workingDir = ""): Event[] {
    if (harnessSessionID === "") {
      throw wrap("codex transcript: empty session id", ErrEmptySessionID);
    }
    const file = this.locate(harnessSessionID);
    return parseJSONL(file);
  }

  // readUsage returns the session's cumulative token totals (the last
  // token_count event), or null when the rollout records none. workingDir is
  // ignored, mirroring read().
  readUsage(harnessSessionID: string, _workingDir = ""): Usage | null {
    if (harnessSessionID === "") {
      throw wrap("codex usage: empty session id", ErrEmptySessionID);
    }
    const file = this.locate(harnessSessionID);
    let data: string;
    try {
      data = readFileSync(file, "utf8");
    } catch (err) {
      throw wrap(`codex usage: open ${file}`, err);
    }
    return usageFromCodexJSONL(data);
  }

  // locateLatestSession is the disk-based fallback used when the screen-scrape
  // session-id extractor finds nothing (Codex 0.142+).
  locateLatestSession(workingDir: string): string | undefined {
    return locateLatestSession(this.resolveRoot(), workingDir);
  }

  /**
   * resolveRoot — explicit sessionsRoot → $CODEX_HOME/sessions → ~/.codex/sessions.
   *
   * The CODEX_HOME rung exists because codex's session log moves with an
   * ISOLATED CODEX_HOME (the containment mechanism behind the "Approve for me"
   * permission preset): without it a run under an isolated home silently reads
   * the user's global root and reports an empty transcript with null usage.
   *
   * It is what makes src/cli/structured-runner.ts's module-level readTranscript
   * / readUsage correct — they construct `new CodexReader()` with NO root. That
   * is COMPLETE for the one-shot CLI path by construction: buildGuestEnv
   * (structured-runner.ts) derives the guest env from the runner's own
   * process.env verbatim, so any CODEX_HOME that reaches the child is by
   * definition also in the runner's environment, where this fallback sees it.
   *
   * DOCUMENTED LIMIT: an isolated home supplied only through `Options.env` —
   * i.e. never exported into the host process — is invisible here, because
   * readTranscript / readUsage take no root parameter. Such a run reads the
   * default root and returns an empty transcript. Widening those exported
   * signatures is deliberately out of scope; callers that isolate via
   * Options.env should construct CodexReader with an explicit sessionsRoot (the
   * route CodexAdapter takes).
   */
  resolveRoot(): string {
    if (this.sessionsRoot !== "") return this.sessionsRoot;
    const home = process.env.CODEX_HOME;
    if (home !== undefined && home !== "") return path.join(home, "sessions");
    return path.join(homedir(), ".codex", "sessions");
  }

  // locate scans the sessions root for a file whose name ends with the session
  // UUID suffix (rollout-<timestamp>-<uuid>.jsonl).
  private locate(sessionID: string): string {
    const root = this.resolveRoot();
    const suffix = "-" + sessionID + ".jsonl";
    for (const p of walkJSONL(root)) {
      if (path.basename(p).endsWith(suffix)) return p;
    }
    throw wrap(
      `codex transcript: no session file for ${sessionID} under ${root}`,
      ErrSessionNotFound,
    );
  }
}

function parseJSONL(p: string): Event[] {
  let data: string;
  try {
    data = readFileSync(p, "utf8");
  } catch (err) {
    throw wrap(`codex transcript: open ${p}`, err);
  }
  return events(data);
}
