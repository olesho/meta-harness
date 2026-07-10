// Last-stdout-line JSON parser — the host-side inverse of structured-runner's
// emit(). AUTHORED FRESH: no producer parses this JSON today (orche consumes the
// whole stdout; loomcli's parse is spec'd not shipped), so this is brand-new and
// carries its own Tier-1 suite.
//
// The producer emits EXACTLY ONE JSON object line, but real stdout is noisy:
// harness banners or warnings can print BEFORE it, a stray non-JSON line can
// trail AFTER it, and a killed process can leave a TRUNCATED final line. So the
// parse scans lines from the LAST backward and returns the first that parses as
// a JSON OBJECT — tolerating leading noise, a non-JSON tail, a truncated tail,
// and (by taking the last object) multiple JSON lines. Zero JSON ⇒ null.

import type { StructuredTurnResult } from "./protocol.ts"

/**
 * parseLastJSONLine returns the LAST line of `stdout` that parses as a JSON
 * object, or null when no line does. Bare JSON scalars/arrays are rejected — the
 * protocol payload is always an object.
 */
export function parseLastJSONLine(stdout: string): StructuredTurnResult | null {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === "") continue
    let val: unknown
    try {
      val = JSON.parse(line)
    } catch {
      // Non-JSON tail or a truncated final line — keep scanning backward.
      continue
    }
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return val as StructuredTurnResult
    }
    // A bare scalar/array line is not the payload; keep scanning.
  }
  return null
}
