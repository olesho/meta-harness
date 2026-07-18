// Fidelity-distance metrics for the screenbench bake-off, ported from the Go
// `internal/screenbench/metrics/metrics.go`. Pure and dependency-free (aside
// from re-using the wrapper's ANSI stripper). Dev-only bench tooling — lives
// under test/corpus/tools/ and runs via bun; it is NOT part of the shipped
// `src/**` surface.

import { stripANSIEscapes } from "../../../src/wrapper/internal/ansi";

/**
 * Strip ANSI/CSI escape sequences, leaving the printable text. Re-exported
 * from the wrapper's canonical implementation under the Go-side name.
 */
export const StripANSI = stripANSIEscapes;

// ANSI CSI escape sequences (cursor moves, SGR, etc.). Mirrors Go's
// metrics.go `ansiCSI` regex. `stripANSIEscapes` only removes the ESC and its
// single final byte (it treats the `[` as a terminator), so Normalize applies
// this first to strip the CSI parameter/final bytes as well.
const ansiCSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Normalize collapses per-line trailing whitespace and trims trailing blank
 * lines so padding differences don't dominate the comparison. Applied to both
 * the live screen snapshot and the expected-oracle text before scoring.
 *
 * Mirrors Go's metrics.go: (1) strip ANSI/CSI escapes, (2) strip per-line
 * trailing whitespace, (3) strip trailing blank lines at end of the text.
 */
export function Normalize(s: string): string {
  s = StripANSI(s.replace(ansiCSI, ""));
  const lines = s.split("\n").map((ln) => ln.replace(/\s+$/, ""));
  // Trim trailing blank lines.
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end).join("\n");
}

/** ExactMatch reports strict equality of the two (already-normalized) inputs. */
export function ExactMatch(a: string, b: string): boolean {
  return a === b;
}

/**
 * Levenshtein returns the edit distance between two strings (insert/delete/
 * substitute cost 1), counted in runes (Unicode code points). O(len(a)*len(b))
 * time, O(min) space via a rolling row.
 */
export function Levenshtein(a: string, b: string): number {
  let ar = Array.from(a);
  let br = Array.from(b);
  if (ar.length === 0) return br.length;
  if (br.length === 0) return ar.length;
  // Make ar the shorter to reduce memory.
  if (ar.length > br.length) {
    const t = ar;
    ar = br;
    br = t;
  }
  let prev = new Array<number>(ar.length + 1);
  let curr = new Array<number>(ar.length + 1);
  for (let i = 0; i <= ar.length; i++) prev[i] = i;
  for (let j = 1; j <= br.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= ar.length; i++) {
      const cost = ar[i - 1] === br[j - 1] ? 0 : 1;
      const ins = curr[i - 1] + 1;
      const del = prev[i] + 1;
      const sub = prev[i - 1] + cost;
      let m = ins;
      if (del < m) m = del;
      if (sub < m) m = sub;
      curr[i] = m;
    }
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[ar.length];
}

/**
 * NormalizedDistance returns Levenshtein(a,b) / max(len(a), len(b)) in runes,
 * a value in [0,1]. 0 means identical; the empty/empty case is defined as 0.
 */
export function NormalizedDistance(a: string, b: string): number {
  const d = Levenshtein(a, b);
  const max = Math.max(Array.from(a).length, Array.from(b).length);
  if (max === 0) return 0;
  return d / max;
}
