// Shared corpus loader for the turns adapter tests. Mirrors the corpusBytes
// helpers in the Go harness tests: walk up from this file to the repo root and
// read test/corpus/<harness>/<scenario>/bytes.raw. Returns null when the
// recording is absent so callers can skip (faithful to t.Skip in Go).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../src/screen/index.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

/** Builds a synthetic Snapshot carrying only text, mirroring screen.Snapshot{Text}. */
export function textSnap(text: string): Snapshot {
  return { text, cols: 0, rows: 0, cursorCol: 0, cursorRow: 0, generation: 1 };
}

function repoRoot(): string {
  let dir = thisDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "test", "corpus"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate test/corpus from " + thisDir);
}

const root = repoRoot();

/** Loads a corpus recording's raw bytes, or null when it is not present. */
export function corpusBytes(
  harness: string,
  scenario: string,
): Uint8Array | null {
  const p = join(root, "test", "corpus", harness, scenario, "bytes.raw");
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}
