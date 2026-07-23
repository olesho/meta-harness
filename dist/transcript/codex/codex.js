// Reads Codex CLI session transcripts. Codex writes one JSONL per session at:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<session-uuid>.jsonl
// Ported from harness-wrapper's codex/codex.go.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { wrap } from "../../internal/async/index.js";
import { ErrEmptySessionID, ErrSessionNotFound } from "../errors.js";
import { usageFromCodexJSONL } from "../usage.js";
import { locateLatestSession, walkJSONL } from "./locate.js";
import { events } from "./parseCodex.js";
export class CodexReader {
    // sessionsRoot overrides the default ~/.codex/sessions/ location.
    sessionsRoot;
    constructor(sessionsRoot = "") {
        this.sessionsRoot = sessionsRoot;
    }
    // read returns the canonical Event stream for the given Codex session UUID.
    // workingDir is ignored — Codex indexes by date/UUID, not working directory.
    read(harnessSessionID, _workingDir = "") {
        if (harnessSessionID === "") {
            throw wrap("codex transcript: empty session id", ErrEmptySessionID);
        }
        const file = this.locate(harnessSessionID);
        return parseJSONL(file);
    }
    // readUsage returns the session's cumulative token totals (the last
    // token_count event), or null when the rollout records none. workingDir is
    // ignored, mirroring read().
    readUsage(harnessSessionID, _workingDir = "") {
        if (harnessSessionID === "") {
            throw wrap("codex usage: empty session id", ErrEmptySessionID);
        }
        const file = this.locate(harnessSessionID);
        let data;
        try {
            data = readFileSync(file, "utf8");
        }
        catch (err) {
            throw wrap(`codex usage: open ${file}`, err);
        }
        return usageFromCodexJSONL(data);
    }
    // locateLatestSession is the disk-based fallback used when the screen-scrape
    // session-id extractor finds nothing (Codex 0.142+).
    locateLatestSession(workingDir) {
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
     * is COMPLETE for the one-shot CLI path by construction (re-verified against
     * the current code): the runner's only env source is
     * `cleanEnv(buildGuestEnv(process.env, …))`, and neither step can introduce a
     * key — buildGuestEnv forwards the host env verbatim (it only ever overwrites
     * IS_SANDBOX) and cleanEnv merely drops CLAUDECODE / CLAUDE_CODE_*. So any
     * CODEX_HOME that reaches the child is by definition also in the runner's own
     * environment, where this fallback sees it.
     *
     * DOCUMENTED LIMIT: an isolated home supplied only through `Options.env` —
     * i.e. never exported into the host process — is invisible here, because
     * readTranscript / readUsage take no root parameter. Such a run reads the
     * default root and returns an empty transcript. Widening those exported
     * signatures is deliberately out of scope; callers that isolate via
     * Options.env should construct CodexReader with an explicit sessionsRoot (the
     * route CodexAdapter takes).
     */
    resolveRoot() {
        if (this.sessionsRoot !== "")
            return this.sessionsRoot;
        const home = process.env.CODEX_HOME;
        if (home !== undefined && home !== "")
            return path.join(home, "sessions");
        return path.join(homedir(), ".codex", "sessions");
    }
    // locate scans the sessions root for a file whose name ends with the session
    // UUID suffix (rollout-<timestamp>-<uuid>.jsonl).
    locate(sessionID) {
        const root = this.resolveRoot();
        const suffix = "-" + sessionID + ".jsonl";
        for (const p of walkJSONL(root)) {
            if (path.basename(p).endsWith(suffix))
                return p;
        }
        throw wrap(`codex transcript: no session file for ${sessionID} under ${root}`, ErrSessionNotFound);
    }
}
function parseJSONL(p) {
    let data;
    try {
        data = readFileSync(p, "utf8");
    }
    catch (err) {
        throw wrap(`codex transcript: open ${p}`, err);
    }
    return events(data);
}
//# sourceMappingURL=codex.js.map