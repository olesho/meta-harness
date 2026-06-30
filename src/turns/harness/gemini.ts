// Turn-detection adapter for Google's Gemini CLI (@google/gemini-cli).
//
// v0.1, ahead of corpus recording: no end-of-turn screen marker or session-id
// scrape identified yet, so it delegates OnScreen to the generic adapter and
// returns ["", false] from ExtractSessionID. Port of pkg/turns/harness/gemini.

import type { Snapshot } from "../../screen/index.ts"
import { GenericAdapter } from "../generic.ts"
import type { Adapter, Turn } from "../types.ts"

/** Adapter implements turns.Adapter for Gemini CLI. */
export class GeminiAdapter extends GenericAdapter implements Adapter {
  override name(): string {
    return "gemini"
  }

  /** Placeholder; Gemini's TUI session-UUID surface is not yet known. */
  extractSessionID(_snap: Snapshot): [string, boolean] {
    return ["", false]
  }

  /** Implements turns.TranscriptReader. */
  readTranscript(_harnessSessionID: string, _workingDir: string): Turn[] {
    throw new Error("gemini transcript reader not yet ported")
  }
}

/** Constructs a Gemini adapter. */
export function New(): GeminiAdapter {
  return new GeminiAdapter()
}
