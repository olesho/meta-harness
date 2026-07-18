// Path helpers shared by the readers — the TS analogues of Go's filepath.Clean
// / filepath.EvalSymlinks used for cwd canonicalization.

import { realpathSync } from "node:fs";
import path from "node:path";

// cleanPosix mimics Go's filepath.Clean for the slash-style paths the readers
// deal with: normalize and strip a trailing separator (except at root).
export function cleanPosix(p: string): string {
  let n = path.posix.normalize(p.replace(/\\/g, "/"));
  if (n.length > 1) n = n.replace(/\/+$/, "");
  return n;
}

// canonicalDir resolves symlinks (so /tmp/x and the macOS-resolved
// /private/tmp/x compare equal) and falls back to a lexical clean when the path
// can't be stat'd (gone, permission, etc.).
export function canonicalDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return cleanPosix(p);
  }
}
