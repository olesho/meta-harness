// Reads the repo-root versions.json file that pins each supported harness
// CLI to a specific upstream package version.
//
// versions.json is the single source of truth that ties an adapter's code
// (regex fingerprints, classifier patterns, transcript schema assumptions) to
// a specific upstream release.
//
// Schema (one entry per harness name):
//
//   {
//     "codex":       {"package": "@openai/codex",             "binary": "codex",    "pinned": "0.142.5", "verified_at": "2026-07-05"},
//     "claude-code": {"package": "@anthropic-ai/claude-code", "binary": "claude",   "pinned": "2.1.201", "verified_at": "2026-07-05"},
//     ...
//   }
//
// An empty pinned/verified_at string is allowed and means "not yet verified
// against any upstream version". `package` and `binary` are required for every
// entry.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineSentinel, wrap } from "../internal/async/index.js";
// Error sentinels. Tests assert against these via `isSentinel`, never against
// message strings.
export const errEmptyPackage = defineSentinel("versions/empty-package", "versions: entry has empty package");
export const errEmptyBinary = defineSentinel("versions/empty-binary", "versions: entry has empty binary");
export const errVerifiedAtWithoutPinned = defineSentinel("versions/verified-at-without-pinned", "versions: entry has verified_at without pinned");
export const errParse = defineSentinel("versions/parse", "versions: parse");
export const errRead = defineSentinel("versions/read", "versions: read");
// versions.json lives next to this module and is read at load time, the TS
// analogue of Go's //go:embed.
const embeddedPath = join(dirname(fileURLToPath(import.meta.url)), "versions.json");
const embedded = readFileSync(embeddedPath, "utf8");
function parse(data) {
    let raw;
    try {
        raw = JSON.parse(data);
    }
    catch (err) {
        throw wrap(`versions: parse: ${String(err)}`, errParse);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw wrap("versions: parse", errParse);
    }
    const out = new Map();
    for (const [name, e] of Object.entries(raw)) {
        const pkg = typeof e?.package === "string" ? e.package : "";
        const binary = typeof e?.binary === "string" ? e.binary : "";
        const pinned = typeof e?.pinned === "string" ? e.pinned : "";
        const verifiedAt = typeof e?.verified_at === "string" ? e.verified_at : "";
        if (pkg === "") {
            throw wrap(`versions: entry ${JSON.stringify(name)} has empty package`, errEmptyPackage);
        }
        if (binary === "") {
            throw wrap(`versions: entry ${JSON.stringify(name)} has empty binary`, errEmptyBinary);
        }
        if (pinned === "" && verifiedAt !== "") {
            throw wrap(`versions: entry ${JSON.stringify(name)} has verified_at without pinned`, errVerifiedAtWithoutPinned);
        }
        out.set(name, { package: pkg, binary, pinned, verifiedAt });
    }
    return out;
}
/**
 * Returns every harness entry, keyed by harness name. The data is embedded
 * into the package at load time, so the call works from any working directory.
 */
export function all() {
    return parse(embedded);
}
/**
 * Returns the pinned upstream version for a harness as `[version, true]`, or
 * `["", false]` if the harness has no entry or its pin is empty.
 */
export function pinned(harness) {
    let entries;
    try {
        entries = all();
    }
    catch {
        return ["", false];
    }
    const e = entries.get(harness);
    if (!e || e.pinned === "") {
        return ["", false];
    }
    return [e.pinned, true];
}
/**
 * Reads a versions.json at an explicit path. Useful for tests and tooling that
 * operate on a different versions.json (e.g. the corpus rebake pipeline).
 */
export function readFrom(path) {
    let data;
    try {
        data = readFileSync(path, "utf8");
    }
    catch (err) {
        throw wrap(`versions: read ${path}: ${String(err)}`, errRead);
    }
    return parse(data);
}
//# sourceMappingURL=versions.js.map