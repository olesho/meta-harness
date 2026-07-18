// Guards applied to untrusted hook payloads before their contents are trusted:
// a path-traversal guard (built on transcript/pathutil) and a session-mismatch
// guard. Both are pure predicates so the payload parser can call them without
// side effects.

import path from "node:path";

import { canonicalDir, cleanPosix } from "../transcript/pathutil.ts";

// guardPath validates a payload-supplied path stays within baseDir. Absolute
// candidates are cleaned as-is; relative candidates are resolved against the
// canonicalized base. A candidate that escapes the base (via `..`, an absolute
// path outside it, or a symlink out) is rejected with null. On success the
// canonicalized, in-bounds path is returned.
//
// Both sides are canonicalized (symlinks resolved) so /tmp/x and the
// macOS-resolved /private/tmp/x compare equal, matching canonicalDir's
// contract. cleanPosix collapses `..` segments lexically first so a traversal
// is caught even when the escaped target does not exist on disk.
export function guardPath(baseDir: string, candidate: string): string | null {
  if (candidate === "") return null;
  const base = canonicalDir(baseDir);
  const lexical = path.posix.isAbsolute(candidate)
    ? cleanPosix(candidate)
    : cleanPosix(path.posix.join(base, candidate));
  const canon = canonicalDir(lexical);
  const rel = path.posix.relative(base, canon);
  if (rel === "") return canon;
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel))
    return null;
  return canon;
}

// sessionMatches reports whether a payload's session id is acceptable given the
// expected harness session id. An empty `expected` means "no expectation" — any
// id passes (the guard is disarmed until the launch id is known). A non-empty
// expected requires an exact match; a mismatch (a stray hook from an unrelated
// session sharing the same settings.json) fails and its payload is dropped.
export function sessionMatches(
  expected: string | undefined,
  payloadID: string,
): boolean {
  if (!expected) return true;
  return expected === payloadID;
}
