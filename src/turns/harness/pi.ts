// Turn-detection adapter for the pi coding agent (github.com/earendil-works/pi).
//
// Implements a transcript reader (documented JSONL format), session create/resume
// via pi's --session-id/--session flags, a graceful "/quit", and a BusyDetector +
// PromptReady keyed off pi's status line. Port of pkg/turns/harness/pi.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type { Snapshot } from "../../screen/index.ts";
import { PiReader } from "../../transcript/pi/pi.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Turn } from "../types.ts";

const enc = new TextEncoder();

// quitCommand is pi's "/quit" slash command followed by Enter (pi's submit key).
const quitCommand = enc.encode("/quit\r");

// busyTexts are the status-line labels pi paints while a turn is in flight.
// Matching the trailing ellipsis avoids a false hit on the "Thinking Level" menu.
const busyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"];

// statusLineRE matches pi's idle status-line context-usage indicator (e.g.
// "0.0%/131k"). Painted once pi's composer is accepting input.
const statusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/;

function busy(text: string): boolean {
  return busyTexts.some((m) => text.includes(m));
}

/** Adapter implements turns.Adapter for the pi coding agent. */
export class PiAdapter extends GenericAdapter implements Adapter {
  // root overrides the pi agent config directory for the reader/tests (the
  // ~/.pi/agent equivalent). Empty means use the pinned/env-derived dir.
  root = "";
  // pinnedSessionsDir is the absolute sessions dir resolved from the launch env
  // + cwd at Open (see bindLaunchEnv). Empty until bound.
  pinnedSessionsDir = "";

  override name(): string {
    return "pi";
  }

  /**
   * Implements turns.StreamInterleaved. pi's stream-json is `pi -p --mode json`,
   * a headless print mode that SUPPRESSES the TUI (test/corpus/pi/README.md), so
   * it is not emitted interleaved with the interactive session pi runs under
   * here. Not Stream-eligible in A1 — no StreamParser.parseStreamLine is
   * implemented; the Stream branch is scaffolding lit up by a later interleaving
   * adapter.
   */
  streamInterleaved(): boolean {
    return false;
  }

  /**
   * Optional capability: chat calls this once at Open with the effective child
   * env AND cwd, so the reader resolves the same sessions dir the child was
   * launched with (see PI_CODING_AGENT_* precedence).
   */
  bindLaunchEnv(env: string[], workingDir: string): void {
    this.pinnedSessionsDir = piSessionsDirFromEnv(env, workingDir);
  }

  /** Implements turns.SessionInitializer — `pi --session-id <uuid>`. */
  initSession(): [string[], string] {
    const id = randomUUID();
    return [["--session-id", id], id];
  }

  /** Implements turns.SessionResumer — `pi --session <uuid>`. */
  resumeArgs(id: string): string[] {
    return ["--session", id];
  }

  /** Implements turns.SessionControlFlags — flags chat manages, banned from args. */
  sessionControlFlags(): string[] {
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
  readTranscript(harnessSessionID: string, workingDir: string): Turn[] {
    return new PiReader({
      root: this.root,
      sessionsDir: this.pinnedSessionsDir,
    })
      .read(harnessSessionID, workingDir)
      .map((t) => ({ role: t.role, text: t.text, timestamp: t.timestamp }));
  }

  /** Implements turns.Quitter. */
  quitSequence(): Uint8Array {
    return quitCommand;
  }

  /** Implements turns.BusyDetector. */
  busy(snap: Snapshot): boolean {
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
function piSessionsDirFromEnv(env: string[], workingDir: string): string {
  const lookup = (key: string): string | undefined => {
    for (let i = env.length - 1; i >= 0; i--) {
      const e = env[i];
      const eq = e.indexOf("=");
      if (eq < 0) continue;
      if (e.slice(0, eq) === key) return e.slice(eq + 1);
    }
    return undefined;
  };
  const anchor = (p: string): string =>
    path.isAbsolute(p) ? p : path.resolve(workingDir || ".", p);

  const direct = lookup("PI_CODING_AGENT_SESSION_DIR");
  if (direct) return anchor(direct);

  const agentDir = lookup("PI_CODING_AGENT_DIR");
  if (agentDir) return path.join(anchor(agentDir), "sessions");

  const home = lookup("HOME") ?? homedir();
  return path.join(anchor(home), ".pi", "agent", "sessions");
}

/** Constructs a pi adapter. */
export function New(): PiAdapter {
  return new PiAdapter();
}

/**
 * PromptReady reports whether pi's composer is initialized and idle — the status
 * line is painted and no turn is in flight.
 */
export function PromptReady(text: string): boolean {
  return !busy(text) && statusLineRE.test(text);
}
