// Shared corpus-test helpers — the file-walk + manifest-hash drift guard reused
// by every vendored-golden suite (currently test/wire_corpus.test.ts; the auth
// corpus adopts it when it lands here). Kept dependency-free (node builtins only)
// so any test can import it without dragging in the harness runtime.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * walkFiles lists every regular file under `root` (absolute paths, sorted
 * depth-first by name), skipping any file whose path relative to `root` is in
 * `exclude`. Deterministic order so callers can hash/iterate reproducibly.
 */
export function walkFiles(
  root: string,
  exclude: Set<string> = new Set<string>(),
): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(/[\\/]/).join("/");
      if (exclude.has(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * computeManifest renders the canonical `MANIFEST.sha256` body for `root`:
 * one `"<sha256>  <posix-relative-path>"` line per file, **sorted by relative
 * path** (byte order, matching `LC_ALL=C sort` in scripts/sync-corpus.sh so the
 * script and this helper produce byte-identical manifests), trailing newline.
 * `exclude` holds root-relative paths to leave out — always the manifest itself,
 * plus any non-frozen docs (e.g. README.md).
 */
export function computeManifest(root: string, exclude: Set<string>): string {
  const entries = walkFiles(root, exclude).map((f) => {
    const hash = createHash("sha256").update(readFileSync(f)).digest("hex");
    const rel = relative(root, f).split(/[\\/]/).join("/");
    return { rel, line: `${hash}  ${rel}` };
  });
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = entries.map((e) => e.line);
  return lines.join("\n") + "\n";
}

/** Read + JSON.parse a corpus file. Throws with the path on malformed JSON. */
export function readJSON(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`corpus: invalid JSON in ${path}`, { cause: e });
  }
}
