// Answers "is harness X's CLI installed on PATH, and at what version?" for
// every harness declared in versions.json. It is the single source of truth
// for harness availability across every consumer.
//
// The module is read-only with respect to the filesystem: it never writes,
// never modifies PATH, never installs anything. It holds an in-memory cache of
// detected versions keyed by binary path + mtime so repeated lookups (e.g. in
// a long-running supervisor) are cheap.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { all as allVersions } from "../versions/versions.js";
/**
 * Directories probed by `resolvePath()` after an explicit env override and the
 * live PATH both miss. These cover the common install locations that a stripped
 * PATH (e.g. a detached supervisor that lost nvm's bin dir) would omit.
 *
 * `~` expansion depends on `HOME` (`USERPROFILE` on Windows); when it cannot be
 * resolved, the tilde entries are silently skipped rather than treated as an
 * error.
 *
 * The list is hardcoded and Unix-oriented for the MVP. Follow-up phases can make
 * it configurable or add platform-specific entries (e.g. `%APPDATA%\npm` on
 * Windows, `/snap/bin` on Linux). Windows support is deferred to Phase 2.
 */
export const WELL_KNOWN_DIRS = [
    "~/.claude/local/bin",
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];
/**
 * Bounds a single `<binary> --version` invocation. A safety net for a hung
 * binary, not a latency target, so it is set generously: the harness CLIs are
 * node-based and a cold `--version` can take 1-2s just for node to start.
 */
export const defaultProbeTimeoutMs = 10_000;
const probes = new Map();
/**
 * Associates a version probe with a canonical harness key. Overwrites any
 * prior registration. Throws if `p` is nullish.
 */
export function registerProbe(harness, p) {
    if (p == null) {
        throw new Error("discovery: registerProbe called with nil Probe");
    }
    probes.set(harness, p);
}
export function probeFor(harness) {
    return probes.get(harness);
}
// Test-only access to the live registry, mirroring in-package access to the
// `probes` map in the Go tests.
export const _probes = probes;
const cache = new Map();
/** Clears the version-detection cache. Intended for tests that swap a shim. */
export function resetCache() {
    cache.clear();
}
/**
 * Whether `p` names an existing regular file with the execute bit set. Follows
 * symlinks (statSync), so a `claude` → `claude.exe` symlink whose target exists
 * passes and a dangling symlink fails.
 *
 * Unix-only for the MVP: the `X_OK` check relies on the execute bit, which
 * Windows does not model (every file is "executable"). Windows/PATHEXT support
 * is deferred to Phase 2.
 */
function isExecutable(p) {
    try {
        if (!statSync(p).isFile())
            return false;
        accessSync(p, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Resolves a bare binary name against PATH, returning its absolute path or null. */
function lookPath(binary, env = process.env) {
    const raw = env.PATH ?? "";
    for (const dir of raw.split(delimiter)) {
        if (dir === "")
            continue;
        if (isExecutable(join(dir, binary)))
            return join(dir, binary);
    }
    return null;
}
/**
 * Expands a leading `~` in a well-known-dir entry using `HOME` (falling back to
 * the caller env's HOME, then the process HOME, then os.homedir()). Returns null
 * when the entry needs `~` expansion but no home directory can be determined, so
 * the caller skips it instead of probing a bogus path.
 */
function expandTilde(dir, env) {
    if (dir !== "~" && !dir.startsWith("~/"))
        return dir;
    const home = env.HOME ?? env.USERPROFILE ?? process.env.HOME ?? homedir();
    if (!home)
        return null;
    return dir === "~" ? home : join(home, dir.slice(2));
}
/**
 * Probes WELL_KNOWN_DIRS for `binary`, returning its absolute path or null.
 * Independent of `process.execPath`, so it succeeds identically under bun or
 * node regardless of which runtime owns the calling interpreter's bin dir.
 */
function lookWellKnownDirs(binary, env) {
    for (const entry of WELL_KNOWN_DIRS) {
        const dir = expandTilde(entry, env);
        if (dir === null)
            continue; // ~ could not be expanded — skip, not an error
        if (isExecutable(join(dir, binary)))
            return join(dir, binary);
    }
    return null;
}
function cachedDetect(p, path) {
    let mtimeMs;
    try {
        mtimeMs = statSync(path).mtimeMs;
    }
    catch (err) {
        return { version: "", err: new Error(`stat ${path}: ${String(err)}`) };
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) {
        return { version: hit.version, err: hit.err };
    }
    let version = "";
    let err = null;
    try {
        version = p.detect(path);
    }
    catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
    }
    cache.set(path, { mtimeMs, version, err });
    return { version, err };
}
/** The env-override variable name for a harness, e.g. `HARNESS_BINARY_CLAUDE_CODE`. */
function envOverrideKey(name) {
    return "HARNESS_BINARY_" + name.toUpperCase().replace(/-/g, "_");
}
/** Maps a lookup name to its canonical harness key, entry, and probe binary. */
function resolveName(name) {
    const entries = allVersions();
    const direct = entries.get(name);
    if (direct)
        return { harness: name, entry: direct, binary: direct.binary };
    for (const [k, e] of entries) {
        if (e.binary === name)
            return { harness: k, entry: e, binary: e.binary };
    }
    return { harness: "", entry: undefined, binary: name };
}
/**
 * Shared path-resolution core for `lookup` and `resolvePath`. Resolution order:
 *
 *   0. A path-bearing `name` (absolute or containing `/`) is checked directly.
 *   1. An explicit env override (`HARNESS_BINARY_<NAME>` or `HARNESS_BINARY`):
 *      an absolute override is verified directly and does NOT fall through on
 *      miss; a bare-name override is searched on PATH only.
 *   2. The live PATH (from `env.PATH`).
 *   3. WELL_KNOWN_DIRS — only when `includeWellKnown` is set (resolvePath).
 *
 * Returns the resolved absolute path, or null when the binary is not found.
 */
function resolveBinaryPath(name, binary, env, includeWellKnown) {
    // 0. Path-bearing name — an explicit path the caller already chose.
    if (isAbsolute(name) || name.includes("/")) {
        return isExecutable(name) ? name : null;
    }
    // 1. Explicit env override. A present override is authoritative: an absolute
    //    override never falls through to PATH/well-known on miss.
    const override = env[envOverrideKey(name)] ?? env.HARNESS_BINARY;
    if (override !== undefined && override !== "") {
        if (isAbsolute(override) || override.includes("/")) {
            return isExecutable(override) ? override : null;
        }
        return lookPath(override, env);
    }
    // 2. Live PATH.
    const onPath = lookPath(binary, env);
    if (onPath !== null)
        return onPath;
    // 3. Well-known dirs (resolvePath only).
    if (includeWellKnown)
        return lookWellKnownDirs(binary, env);
    return null;
}
/**
 * Resolves a harness name to its absolute binary path, or null when not found.
 * Unlike `lookup().path`, this consults WELL_KNOWN_DIRS after an explicit env
 * override and the live PATH both miss, making it robust to a stripped PATH and
 * independent of `process.execPath` (so it behaves identically under bun or
 * node). This is the SSOT resolver consumers should defer to.
 *
 * `env` defaults to `process.env`; callers may pass a custom env (e.g. carrying
 * `HARNESS_BINARY_*` overrides, or a stubbed env in tests).
 */
export function resolvePath(name, env) {
    const e = env ?? process.env;
    const { binary } = resolveName(name);
    return resolveBinaryPath(name, binary, e, true);
}
/**
 * Resolves a name to availability info. The name may be a canonical harness
 * key, a registered binary name, or any other binary name (treated as a raw
 * PATH probe). Throws only for internal failures (e.g. versions.json
 * unreadable); a binary that is simply not on PATH is a normal result with
 * `installed` false.
 *
 * `Info.path` reflects PATH/override resolution only (no well-known dirs) — use
 * `resolvePath()` for the full, PATH-strip-robust chain. `env` defaults to
 * `process.env`.
 */
export function lookup(name, env) {
    const e = env ?? process.env;
    const { harness, entry, binary } = resolveName(name);
    const info = {
        name,
        harness,
        binary,
        path: "",
        installed: false,
        installHint: "",
        pinnedVersion: entry?.pinned ?? "",
        detectedVersion: "",
        // Default true so callers never treat "unknown" as drift; only flipped to
        // false when both pinned and detected are populated and unequal.
        versionMatchesPin: true,
        versionProbeError: "",
        npmPackage: entry?.package ?? "",
    };
    const path = resolveBinaryPath(name, binary, e, false);
    if (path === null) {
        info.installHint = buildInstallHint(binary, harness, entry?.package ?? "");
        return info;
    }
    info.path = path;
    info.installed = true;
    if (harness === "") {
        return info;
    }
    const probe = probeFor(harness);
    if (!probe) {
        return info;
    }
    const { version, err } = cachedDetect(probe, path);
    if (err) {
        info.versionProbeError = err.message;
        return info;
    }
    info.detectedVersion = version;
    if (entry.pinned !== "") {
        info.versionMatchesPin = version === entry.pinned;
    }
    return info;
}
/**
 * Returns Info for every harness declared in versions.json. Order is not
 * guaranteed.
 */
export function discover() {
    const entries = allVersions();
    const out = [];
    for (const harness of entries.keys()) {
        out.push(lookup(harness));
    }
    return out;
}
function buildInstallHint(binary, harness, npmPkg) {
    if (npmPkg !== "" && harness !== "") {
        return `${JSON.stringify(binary)} not on PATH. Install ${harness} (e.g. \`npm i -g ${npmPkg}\`).`;
    }
    return `${JSON.stringify(binary)} not on PATH.`;
}
//# sourceMappingURL=discovery.js.map