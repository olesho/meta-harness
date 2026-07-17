// Path-traversal guard, built on the EXISTING transcript pathutil (Go analogues
// of filepath.Clean / filepath.EvalSymlinks). We reuse those rather than growing
// a parallel copy. Consumed by the hook payload parser to reject a `cwd` /
// transcript path that escapes its expected base directory.
import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalDir, cleanPosix } from "../transcript/pathutil.js";
// canonicalize resolves symlinks on the longest existing prefix of `abs` (via
// canonicalDir, the EvalSymlinks analogue) and re-appends the non-existent
// remainder. This is what lets us compare a not-yet-created child against a
// symlinked base (e.g. macOS /var -> /private/var) without falsely flagging it.
function canonicalize(abs) {
    const cleaned = cleanPosix(abs);
    const parts = cleaned.split("/");
    for (let i = parts.length; i > 0; i--) {
        const prefix = parts.slice(0, i).join("/") || "/";
        if (existsSync(prefix)) {
            const canon = cleanPosix(canonicalDir(prefix));
            const rest = parts.slice(i);
            return rest.length ? cleanPosix(`${canon}/${rest.join("/")}`) : canon;
        }
    }
    return cleaned;
}
export class PathEscapeError extends Error {
    baseDir;
    candidate;
    constructor(baseDir, candidate) {
        super(`path escapes base directory: ${candidate} (base ${baseDir})`);
        this.name = "PathEscapeError";
        this.baseDir = baseDir;
        this.candidate = candidate;
    }
}
// resolveWithinBase resolves `candidate` (absolute, or relative to `baseDir`)
// and asserts the result stays within `baseDir`. Both endpoints are canonical-
// ised (symlinks resolved via canonicalDir, lexically cleaned via cleanPosix) so
// `../` escapes — and symlink escapes — are rejected. Returns the canonical
// resolved path; throws PathEscapeError on escape.
export function resolveWithinBase(baseDir, candidate) {
    const base = canonicalize(baseDir);
    const joined = path.posix.isAbsolute(candidate.replace(/\\/g, "/"))
        ? cleanPosix(candidate)
        : cleanPosix(path.posix.join(base, candidate));
    const resolved = canonicalize(joined);
    if (resolved !== base && !resolved.startsWith(`${base}/`)) {
        throw new PathEscapeError(baseDir, candidate);
    }
    return resolved;
}
// isWithinBase is the non-throwing predicate form of resolveWithinBase.
export function isWithinBase(baseDir, candidate) {
    try {
        resolveWithinBase(baseDir, candidate);
        return true;
    }
    catch (err) {
        if (err instanceof PathEscapeError)
            return false;
        throw err;
    }
}
//# sourceMappingURL=pathguard.js.map