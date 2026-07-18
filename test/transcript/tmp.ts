import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// tempDir creates a fresh temporary directory (the bun analogue of Go's
// t.TempDir()). Cleanup is left to the OS temp reaper, matching the
// throwaway-fixture style of the ported tests.
export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mh-transcript-"));
}
