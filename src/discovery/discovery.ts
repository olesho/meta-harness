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
import { all as allVersions, type Entry } from "../versions/versions.ts";

/**
 * Environment shape accepted by the resolvers. Mirrors `process.env`
 * (values may be undefined) so `process.env` can be passed verbatim, while
 * callers may also pass a plain `Record<string, string>`.
 */
type EnvLike = Record<string, string | undefined>;

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
export const WELL_KNOWN_DIRS: readonly string[] = [
  "~/.claude/local/bin",
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/** Describes the availability and version state of one harness CLI. */
export interface Info {
  /** The lookup name the caller passed in. */
  name: string;
  /** The canonical harness key from versions.json. Empty when `name` is unknown. */
  harness: string;
  /** The on-PATH executable name actually probed. */
  binary: string;
  /**
   * Absolute path of the binary as resolved on PATH (or from an explicit
   * `HARNESS_BINARY_*` override). Well-known directories are consulted only by
   * `resolvePath()`; `Info.path` stays PATH/override-only for backwards
   * compatibility, so `discover()` keeps its historical "on PATH?" meaning.
   * Empty when not installed.
   */
  path: string;
  /** Whether `binary` was found on PATH. */
  installed: boolean;
  /** One-line hint shown when `installed` is false. Empty otherwise. */
  installHint: string;
  /** The versions.json `pinned` value; empty for unknown/unpinned harnesses. */
  pinnedVersion: string;
  /** Version parsed from the binary's `--version` output, when a probe ran. */
  detectedVersion: string;
  /**
   * Whether `detectedVersion` equals `pinnedVersion`. True when either is empty
   * — callers must not treat "unknown" as drift.
   */
  versionMatchesPin: boolean;
  /** Human-readable failure reason when a registered probe was attempted but failed. */
  versionProbeError: string;
  /** The versions.json `package` value; empty for unknown harnesses. */
  npmPackage: string;
}

/**
 * Parses a harness binary's version from its `--version` (or equivalent)
 * output. Implementations should be cheap (one subprocess call) and treat
 * parse failures as errors rather than returning the raw output.
 */
export interface Probe {
  detect(binPath: string): string;
}

/**
 * Bounds a single `<binary> --version` invocation. A safety net for a hung
 * binary, not a latency target, so it is set generously: the harness CLIs are
 * node-based and a cold `--version` can take 1-2s just for node to start.
 */
export const defaultProbeTimeoutMs = 10_000;

const probes = new Map<string, Probe>();

/**
 * Associates a version probe with a canonical harness key. Overwrites any
 * prior registration. Throws if `p` is nullish.
 */
export function registerProbe(
  harness: string,
  p: Probe | null | undefined,
): void {
  if (p == null) {
    throw new Error("discovery: registerProbe called with nil Probe");
  }
  probes.set(harness, p);
}

export function probeFor(harness: string): Probe | undefined {
  return probes.get(harness);
}

// Test-only access to the live registry, mirroring in-package access to the
// `probes` map in the Go tests.
export const _probes = probes;

interface CacheEntry {
  mtimeMs: number;
  version: string;
  err: Error | null;
}

const cache = new Map<string, CacheEntry>();

/** Clears the version-detection cache. Intended for tests that swap a shim. */
export function resetCache(): void {
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
function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a bare binary name against PATH, returning its absolute path or null. */
function lookPath(binary: string, env: EnvLike = process.env): string | null {
  const raw = env.PATH ?? "";
  for (const dir of raw.split(delimiter)) {
    if (dir === "") continue;
    if (isExecutable(join(dir, binary))) return join(dir, binary);
  }
  return null;
}

/**
 * Expands a leading `~` in a well-known-dir entry using `HOME` (falling back to
 * the caller env's HOME, then the process HOME, then os.homedir()). Returns null
 * when the entry needs `~` expansion but no home directory can be determined, so
 * the caller skips it instead of probing a bogus path.
 */
function expandTilde(dir: string, env: EnvLike): string | null {
  if (dir !== "~" && !dir.startsWith("~/")) return dir;
  const home = env.HOME ?? env.USERPROFILE ?? process.env.HOME ?? homedir();
  if (!home) return null;
  return dir === "~" ? home : join(home, dir.slice(2));
}

/**
 * Probes WELL_KNOWN_DIRS for `binary`, returning its absolute path or null.
 * Independent of `process.execPath`, so it succeeds identically under bun or
 * node regardless of which runtime owns the calling interpreter's bin dir.
 */
function lookWellKnownDirs(binary: string, env: EnvLike): string | null {
  for (const entry of WELL_KNOWN_DIRS) {
    const dir = expandTilde(entry, env);
    if (dir === null) continue; // ~ could not be expanded — skip, not an error
    if (isExecutable(join(dir, binary))) return join(dir, binary);
  }
  return null;
}

function cachedDetect(
  p: Probe,
  path: string,
): { version: string; err: Error | null } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    return { version: "", err: new Error(`stat ${path}: ${String(err)}`) };
  }

  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) {
    return { version: hit.version, err: hit.err };
  }

  let version = "";
  let err: Error | null = null;
  try {
    version = p.detect(path);
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }
  cache.set(path, { mtimeMs, version, err });
  return { version, err };
}

/** The env-override variable name for a harness, e.g. `HARNESS_BINARY_CLAUDE_CODE`. */
function envOverrideKey(name: string): string {
  return "HARNESS_BINARY_" + name.toUpperCase().replace(/-/g, "_");
}

/** Maps a lookup name to its canonical harness key, entry, and probe binary. */
function resolveName(name: string): {
  harness: string;
  entry?: Entry;
  binary: string;
} {
  const entries = allVersions();
  const direct = entries.get(name);
  if (direct) return { harness: name, entry: direct, binary: direct.binary };
  for (const [k, e] of entries) {
    if (e.binary === name) return { harness: k, entry: e, binary: e.binary };
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
function resolveBinaryPath(
  name: string,
  binary: string,
  env: EnvLike,
  includeWellKnown: boolean,
): string | null {
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
  if (onPath !== null) return onPath;

  // 3. Well-known dirs (resolvePath only).
  if (includeWellKnown) return lookWellKnownDirs(binary, env);
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
export function resolvePath(
  name: string,
  env?: Record<string, string>,
): string | null {
  const e: EnvLike = env ?? process.env;
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
export function lookup(name: string, env?: Record<string, string>): Info {
  const e: EnvLike = env ?? process.env;
  const { harness, entry, binary } = resolveName(name);

  const info: Info = {
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
  if (entry!.pinned !== "") {
    info.versionMatchesPin = version === entry!.pinned;
  }
  return info;
}

/**
 * Returns Info for every harness declared in versions.json. Order is not
 * guaranteed.
 */
export function discover(): Info[] {
  const entries = allVersions();
  const out: Info[] = [];
  for (const harness of entries.keys()) {
    out.push(lookup(harness));
  }
  return out;
}

function buildInstallHint(
  binary: string,
  harness: string,
  npmPkg: string,
): string {
  if (npmPkg !== "" && harness !== "") {
    return `${JSON.stringify(binary)} not on PATH. Install ${harness} (e.g. \`npm i -g ${npmPkg}\`).`;
  }
  return `${JSON.stringify(binary)} not on PATH.`;
}
