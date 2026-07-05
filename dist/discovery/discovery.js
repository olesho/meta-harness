// Answers "is harness X's CLI installed on PATH, and at what version?" for
// every harness declared in versions.json. It is the single source of truth
// for harness availability across every consumer.
//
// The module is read-only with respect to the filesystem: it never writes,
// never modifies PATH, never installs anything. It holds an in-memory cache of
// detected versions keyed by binary path + mtime so repeated lookups (e.g. in
// a long-running supervisor) are cheap.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { all as allVersions } from "../versions/versions.js";
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
/** Resolves a bare binary name against PATH, returning its absolute path or null. */
function lookPath(binary) {
    const raw = process.env.PATH ?? "";
    for (const dir of raw.split(delimiter)) {
        if (dir === "")
            continue;
        const full = join(dir, binary);
        try {
            accessSync(full, constants.X_OK);
            if (statSync(full).isFile())
                return full;
        }
        catch {
            // not here / not executable — keep scanning
        }
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
/**
 * Resolves a name to availability info. The name may be a canonical harness
 * key, a registered binary name, or any other binary name (treated as a raw
 * PATH probe). Throws only for internal failures (e.g. versions.json
 * unreadable); a binary that is simply not on PATH is a normal result with
 * `installed` false.
 */
export function lookup(name) {
    const entries = allVersions();
    let harness = "";
    let entry;
    let binary = name;
    const direct = entries.get(name);
    if (direct) {
        harness = name;
        entry = direct;
        binary = direct.binary;
    }
    else {
        for (const [k, e] of entries) {
            if (e.binary === name) {
                harness = k;
                entry = e;
                binary = e.binary;
                break;
            }
        }
    }
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
    const path = lookPath(binary);
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