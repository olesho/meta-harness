// Disk-based session recovery for Codex. Codex 0.142 stopped printing the
// "codex resume <uuid>" hint, so the on-disk session_meta envelope is the
// version-independent anchor for recovering the session id. Ported from
// harness-wrapper's codex/locate.go.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalDir } from "../pathutil.js";
// walkJSONL yields every *.jsonl file path under root (recursively). Unreadable
// subtrees are skipped rather than aborting the walk.
export function walkJSONL(root) {
    const out = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory())
                visit(p);
            else if (e.name.endsWith(".jsonl"))
                out.push(p);
        }
    };
    visit(root);
    return out;
}
// locateLatestSession returns the session UUID of the most recently modified
// rollout whose session_meta cwd matches workingDir. Returns undefined when
// workingDir is empty or no rollout matches.
export function locateLatestSession(sessionsRoot, workingDir) {
    if (workingDir === "")
        return undefined;
    const want = canonicalDir(workingDir);
    let bestID;
    let bestMod = 0;
    for (const p of walkJSONL(sessionsRoot)) {
        const meta = readSessionMeta(p);
        if (!meta?.session_id || canonicalDir(meta.cwd ?? "") !== want)
            continue;
        let mod;
        try {
            mod = statSync(p).mtimeMs;
        }
        catch {
            continue;
        }
        if (bestID === undefined || mod > bestMod) {
            bestID = meta.session_id;
            bestMod = mod;
        }
    }
    return bestID;
}
// readSessionMeta reads the first line of a rollout and, if it is a
// session_meta envelope, returns its payload. Returns undefined for empty,
// unreadable, malformed, or non-session_meta files.
export function readSessionMeta(p) {
    let data;
    try {
        data = readFileSync(p, "utf8");
    }
    catch {
        return undefined;
    }
    const first = data.split("\n", 1)[0];
    if (!first)
        return undefined;
    let env;
    try {
        env = JSON.parse(first);
    }
    catch {
        return undefined;
    }
    if (env.type !== "session_meta")
        return undefined;
    return env.payload ?? undefined;
}
//# sourceMappingURL=locate.js.map