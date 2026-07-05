// Turn-detection adapter for the pi coding agent (github.com/earendil-works/pi).
//
// Implements a transcript reader (documented JSONL format), session create/resume
// via pi's --session-id/--session flags, a graceful "/quit", and a BusyDetector +
// PromptReady keyed off pi's status line. Port of pkg/turns/harness/pi.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { PiReader } from "../../transcript/pi/pi.js";
import { GenericAdapter } from "../generic.js";
const enc = new TextEncoder();
// quitCommand is pi's "/quit" slash command followed by Enter (pi's submit key).
const quitCommand = enc.encode("/quit\r");
// busyTexts are the status-line labels pi paints while a turn is in flight.
// Matching the trailing ellipsis avoids a false hit on the "Thinking Level" menu.
const busyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"];
// statusLineRE matches pi's idle status-line context-usage indicator (e.g.
// "0.0%/131k"). Painted once pi's composer is accepting input.
const statusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/;
function busy(text) {
    return busyTexts.some((m) => text.includes(m));
}
/** Adapter implements turns.Adapter for the pi coding agent. */
export class PiAdapter extends GenericAdapter {
    // root overrides the pi agent config directory for the reader/tests (the
    // ~/.pi/agent equivalent). Empty means use the pinned/env-derived dir.
    root = "";
    // pinnedSessionsDir is the absolute sessions dir resolved from the launch env
    // + cwd at Open (see bindLaunchEnv). Empty until bound.
    pinnedSessionsDir = "";
    name() {
        return "pi";
    }
    /**
     * Optional capability: chat calls this once at Open with the effective child
     * env AND cwd, so the reader resolves the same sessions dir the child was
     * launched with (see PI_CODING_AGENT_* precedence).
     */
    bindLaunchEnv(env, workingDir) {
        this.pinnedSessionsDir = piSessionsDirFromEnv(env, workingDir);
    }
    /** Implements turns.SessionInitializer — `pi --session-id <uuid>`. */
    initSession() {
        const id = randomUUID();
        return [["--session-id", id], id];
    }
    /** Implements turns.SessionResumer — `pi --session <uuid>`. */
    resumeArgs(id) {
        return ["--session", id];
    }
    /** Implements turns.SessionControlFlags — flags chat manages, banned from args. */
    sessionControlFlags() {
        return [
            "--session",
            "--session-id",
            "--fork",
            "-c",
            "--continue",
            "-r",
            "--resume",
            "--no-session",
            "--session-dir",
        ];
    }
    /** Implements turns.TranscriptReader. Timestamp is forwarded as-is (may be undefined). */
    readTranscript(harnessSessionID, workingDir) {
        return new PiReader({ root: this.root, sessionsDir: this.pinnedSessionsDir })
            .read(harnessSessionID, workingDir)
            .map((t) => ({ role: t.role, text: t.text, timestamp: t.timestamp }));
    }
    /** Implements turns.Quitter. */
    quitSequence() {
        return quitCommand;
    }
    /** Implements turns.BusyDetector. */
    busy(snap) {
        return busy(snap.text);
    }
}
/**
 * piSessionsDirFromEnv resolves pi's sessions directory from an env array
 * ("KEY=VALUE" entries), applying pi's precedence: PI_CODING_AGENT_SESSION_DIR
 * is the sessions dir directly, else ${PI_CODING_AGENT_DIR || $HOME/.pi/agent}/
 * sessions. HOME is read from the same array. Relative values are resolved
 * against workingDir — the child's cwd — matching how pi itself resolves them.
 */
function piSessionsDirFromEnv(env, workingDir) {
    const lookup = (key) => {
        for (let i = env.length - 1; i >= 0; i--) {
            const e = env[i];
            const eq = e.indexOf("=");
            if (eq < 0)
                continue;
            if (e.slice(0, eq) === key)
                return e.slice(eq + 1);
        }
        return undefined;
    };
    const anchor = (p) => path.isAbsolute(p) ? p : path.resolve(workingDir || ".", p);
    const direct = lookup("PI_CODING_AGENT_SESSION_DIR");
    if (direct)
        return anchor(direct);
    const agentDir = lookup("PI_CODING_AGENT_DIR");
    if (agentDir)
        return path.join(anchor(agentDir), "sessions");
    const home = lookup("HOME") ?? homedir();
    return path.join(anchor(home), ".pi", "agent", "sessions");
}
/** Constructs a pi adapter. */
export function New() {
    return new PiAdapter();
}
/**
 * PromptReady reports whether pi's composer is initialized and idle — the status
 * line is painted and no turn is in flight.
 */
export function PromptReady(text) {
    return !busy(text) && statusLineRE.test(text);
}
//# sourceMappingURL=pi.js.map