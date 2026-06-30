// Turn-detection adapter for the pi coding agent (github.com/earendil-works/pi).
//
// Implements a transcript reader (documented JSONL format), a graceful "/quit",
// and a BusyDetector + PromptReady keyed off pi's status line. No end-of-turn
// screen marker or session-id scrape identified yet, so OnScreen delegates to
// the generic adapter. Port of pkg/turns/harness/pi.

import type { Snapshot } from "../../screen/index.ts"
import { GenericAdapter } from "../generic.ts"
import type { Adapter, Turn } from "../types.ts"

const enc = new TextEncoder()

// quitCommand is pi's "/quit" slash command followed by Enter (pi's submit key).
const quitCommand = enc.encode("/quit\r")

// busyTexts are the status-line labels pi paints while a turn is in flight.
// Matching the trailing ellipsis avoids a false hit on the "Thinking Level" menu.
const busyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"]

// statusLineRE matches pi's idle status-line context-usage indicator (e.g.
// "0.0%/131k"). Painted once pi's composer is accepting input.
const statusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/

function busy(text: string): boolean {
  return busyTexts.some((m) => text.includes(m))
}

/** Adapter implements turns.Adapter for the pi coding agent. */
export class PiAdapter extends GenericAdapter implements Adapter {
  override name(): string {
    return "pi"
  }

  /** Implements turns.TranscriptReader. */
  readTranscript(_harnessSessionID: string, _workingDir: string): Turn[] {
    throw new Error("pi transcript reader not yet ported")
  }

  /** Implements turns.Quitter. */
  quitSequence(): Uint8Array {
    return quitCommand
  }

  /** Implements turns.BusyDetector. */
  busy(snap: Snapshot): boolean {
    return busy(snap.text)
  }
}

/** Constructs a pi adapter. */
export function New(): PiAdapter {
  return new PiAdapter()
}

/**
 * PromptReady reports whether pi's composer is initialized and idle — the status
 * line is painted and no turn is in flight.
 */
export function PromptReady(text: string): boolean {
  return !busy(text) && statusLineRE.test(text)
}
