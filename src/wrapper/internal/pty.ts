// The parent-side PTY abstraction.
//
// node-pty's native read loop is dead under Bun, so the wrapper never talks to
// node-pty directly. Instead it spawns a small Node bridge (ptyHost.mjs) that
// owns the real PTY and proxies it over an ordinary stdio pipe — which Bun
// reads fine. PtyProcess hides the bridge behind a node-pty-shaped surface:
// onData / onExit callbacks plus write / resize / kill.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineSentinel,
  type Sentinel,
  wrap,
} from "../../internal/async/errors.ts";
import { ErrBinaryNotFound } from "./config.ts";

/** PTY allocation failed (bridge could not be spawned or the harness PTY died on open). */
export const ErrPTYAllocation: Sentinel = defineSentinel(
  "wrapper:pty-allocation",
  "wrapper: pty allocation failed",
);
/** A read on the PTY master failed. */
export const ErrPTYRead: Sentinel = defineSentinel(
  "wrapper:pty-read",
  "wrapper: pty read failed",
);
/**
 * The Node interpreter that runs the PTY bridge could not be found. The bridge
 * is spawned by name ("node") unless a real interpreter is resolvable; when the
 * gate shell has no `node` on PATH the spawn fails ENOENT. Distinguishing this
 * from a genuine {@link ErrPTYAllocation} keeps a missing interpreter from being
 * mis-reported as a PTY failure (META-HARNESS-34).
 */
export const ErrNodeNotFound: Sentinel = defineSentinel(
  "wrapper:node-not-found",
  "wrapper: node interpreter not found for the PTY bridge; add node to PATH or set META_HARNESS_NODE",
);

/**
 * Resolve the PTY bridge path. By default it sits next to this module, but when
 * this module is bundled (e.g. esbuild inlines it into a consumer's server.mjs),
 * `import.meta.url` points at the bundle — not at ptyHost.mjs. Consumers that
 * relocate the bridge set META_HARNESS_PTY_HOST to its absolute path. Resolved
 * lazily at spawn time (not module-eval), so the override only needs to be in the
 * environment before {@link PtyProcess.spawn} runs — no import-order constraint.
 */
export function resolveHost(): string {
  const override = process.env.META_HARNESS_PTY_HOST?.trim();
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), "ptyHost.mjs");
}

/**
 * Well-known absolute node locations to probe when `node` isn't on PATH — the
 * usual Homebrew / system prefixes. Ordered most- to least-preferred.
 */
const COMMON_NODE_PATHS = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/**
 * Locate a real Node interpreter without falling back to a bare name. Resolution
 * order: `META_HARNESS_NODE` → `node` on PATH → the active nvm install →
 * {@link COMMON_NODE_PATHS}. Returns the absolute path, or null when nothing
 * resolves (so callers — e.g. the test preload — can fail loudly). Every
 * candidate is existence/executability checked before it is returned.
 */
export function findNode(env?: Record<string, string>): string | null {
  const override = (
    env?.META_HARNESS_NODE ?? process.env.META_HARNESS_NODE
  )?.trim();
  if (override) return isExecutable(override) ? override : null;
  const onPath = resolveBinary("node", env);
  if (onPath) return onPath;
  return nvmDefaultNode() ?? firstExecutable(COMMON_NODE_PATHS);
}

/**
 * Resolve the interpreter used to spawn the PTY bridge (and, in tests, the
 * `#!/usr/bin/env node` fake harness). In production the wrapper runs under Node,
 * so it reuses `process.execPath` — the same interpreter, zero PATH lookup. Only
 * when running under Bun (e.g. `bun test`, where `process.execPath` is bun) does
 * it hunt for a real `node`, falling back to the bare name so the spawn still
 * attempts and a miss surfaces as {@link ErrNodeNotFound}. `META_HARNESS_NODE`
 * always wins, even under Node, for callers that must pin a specific interpreter.
 */
export function resolveNode(env?: Record<string, string>): string {
  const override = (
    env?.META_HARNESS_NODE ?? process.env.META_HARNESS_NODE
  )?.trim();
  if (override) return override;
  // Production path: already a Node process — reuse it, no PATH dependency.
  if (!process.versions.bun) return process.execPath;
  return findNode(env) ?? "node";
}

/**
 * Resolve the interpreter for the active nvm install. `~/.nvm/alias/default`
 * often names an alias (e.g. `lts/*`) rather than a concrete version, so instead
 * of chasing the alias chain we enumerate `~/.nvm/versions/node/*` and pick the
 * highest version whose `bin/node` is executable. Returns null when nvm isn't
 * installed or holds no usable node.
 */
function nvmDefaultNode(): string | null {
  const versionsDir = join(homedir(), ".nvm", "versions", "node");
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return null;
  }
  const sorted = entries
    .filter((v) => v.startsWith("v"))
    .sort(compareNodeVersionsDesc);
  for (const v of sorted) {
    const candidate = join(versionsDir, v, "bin", "node");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Descending semver-ish compare of `vX.Y.Z` directory names. */
function compareNodeVersionsDesc(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** First executable path in the list, or null. */
function firstExecutable(paths: string[]): string | null {
  for (const p of paths) if (isExecutable(p)) return p;
  return null;
}

const T_READY = "r".charCodeAt(0);
const T_OUTPUT = "o".charCodeAt(0);
const T_EXIT = "x".charCodeAt(0);
const T_STDIN = "i".charCodeAt(0);
const T_RESIZE = "w".charCodeAt(0);
const T_KILL = "k".charCodeAt(0);

/** The exit observation the bridge forwards from node-pty's onExit. */
export interface PtyExit {
  exitCode: number;
  signal: number;
}

export interface PtySpawnOptions {
  binaryPath: string;
  args: string[];
  cwd?: string;
  /** Environment as an object, or undefined to inherit the parent's. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/**
 * PtyProcess is a live handle to a harness running under the Node PTY bridge.
 * Construct with PtyProcess.spawn, which resolves once the bridge reports the
 * harness PID (or rejects if the bridge could not start).
 */
export class PtyProcess {
  private readonly child: ChildProcess;
  private _pid = 0;
  private _exited = false;
  private buf: Uint8Array = new Uint8Array(0);
  private dataCb: ((d: Uint8Array) => void) | null = null;
  private exitCb: ((e: PtyExit) => void) | null = null;

  private constructor(child: ChildProcess) {
    this.child = child;
  }

  /** The harness process PID (0 until the bridge reports ready). */
  get pid(): number {
    return this._pid;
  }

  /**
   * Spawn the bridge and the harness under it. Resolves with a live PtyProcess
   * once the harness PID is known; rejects (wrapping ErrPTYAllocation) if the
   * bridge dies before reporting ready.
   */
  static spawn(opts: PtySpawnOptions): Promise<PtyProcess> {
    const child = spawn(resolveNode(), [resolveHost(), JSON.stringify(opts)], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const p = new PtyProcess(child);

    return new Promise<PtyProcess>((resolve, reject) => {
      let settled = false;
      const onReady = (pid: number) => {
        if (settled) return;
        settled = true;
        p._pid = pid;
        resolve(p);
      };
      const onEarlyExit = (err: unknown) => {
        if (settled) return;
        settled = true;
        // A bridge-spawn ENOENT means the Node interpreter itself is missing —
        // not a PTY failure. Surface it as ErrNodeNotFound so the real cause
        // (no `node` on PATH) is diagnosable instead of an opaque allocation error.
        if (isSpawnENOENT(err)) {
          reject(wrap("wrapper: pty allocation failed", ErrNodeNotFound));
          return;
        }
        reject(wrap("wrapper: pty allocation failed", err ?? ErrPTYAllocation));
      };

      p.readyResolver = onReady;
      child.on("error", onEarlyExit);
      child.on("exit", () => {
        if (!settled) onEarlyExit(ErrPTYAllocation);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        p.feed(chunk);
      });
    });
  }

  private readyResolver: ((pid: number) => void) | null = null;

  private feed(chunk: Uint8Array): void {
    this.buf = this.buf.length === 0 ? chunk : concat(this.buf, chunk);
    for (;;) {
      if (this.buf.length < 5) break;
      const type = this.buf[0];
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      ).getUint32(1, false);
      if (this.buf.length < 5 + len) break;
      const payload = this.buf.subarray(5, 5 + len);
      const rest = this.buf.slice(5 + len);
      this.handle(type, payload);
      this.buf = rest;
    }
  }

  private handle(type: number, payload: Uint8Array): void {
    switch (type) {
      case T_READY: {
        const { pid } = JSON.parse(decode(payload));
        this.readyResolver?.(pid);
        this.readyResolver = null;
        break;
      }
      case T_OUTPUT:
        this.dataCb?.(payload);
        break;
      case T_EXIT: {
        if (this._exited) break;
        this._exited = true;
        const e = JSON.parse(decode(payload));
        this.exitCb?.({ exitCode: e.exitCode ?? -1, signal: e.signal ?? 0 });
        break;
      }
    }
  }

  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: (e: PtyExit) => void): void {
    this.exitCb = cb;
  }

  /** Forward bytes to the harness PTY (keystrokes). */
  write(data: Uint8Array): void {
    if (this._exited) return;
    this.send(T_STDIN, data);
  }

  /** Resize the PTY window. */
  resize(cols: number, rows: number): void {
    if (this._exited) return;
    this.send(T_RESIZE, encode(JSON.stringify({ cols, rows })));
  }

  /** Send a signal to the harness (e.g. "SIGTERM", "SIGKILL"). */
  kill(signal: string): void {
    if (this._exited) return;
    this.send(T_KILL, encode(JSON.stringify({ signal })));
  }

  /** Close the bridge's control channel; tears the harness down if still alive. */
  closeStdin(): void {
    this.child.stdin?.end();
  }

  private send(type: number, payload: Uint8Array): void {
    this.child.stdin?.write(Buffer.from(frame(type, payload)));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Resolve a harness binary the way exec.LookPath would: an absolute or
 * path-bearing name is checked for existence + executability directly; a bare
 * name is searched on PATH. Returns the resolved path, or null when the binary
 * is not found. The wrapper preflights this so Start can return
 * ErrBinaryNotFound before ever spawning the bridge — node-pty only surfaces a
 * missing binary as an opaque exit(1), which is indistinguishable from a real
 * harness failure.
 *
 * @deprecated PATH/abs-path only. The spawn path (run.ts) now defers to the
 * discovery SSOT `resolvePath()`, which additionally consults env overrides and
 * well-known dirs. Kept for backwards compatibility with any external caller.
 */
export function resolveBinary(
  binaryPath: string,
  env?: Record<string, string>,
): string | null {
  if (isAbsolute(binaryPath) || binaryPath.includes("/")) {
    return isExecutable(binaryPath) ? binaryPath : null;
  }
  const pathVar = (env?.PATH ?? process.env.PATH ?? "").split(delimiter);
  for (const dir of pathVar) {
    if (dir === "") continue;
    const candidate = join(dir, binaryPath);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Walk an error's cause chain for a spawn ENOENT (missing executable). */
function isSpawnENOENT(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if ((cur as { code?: unknown }).code === "ENOENT") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Build the cause-chain error Start returns for a missing harness binary. */
export function binaryNotFoundError(binaryPath: string): Error {
  return wrap(
    `wrapper: binary not found: executable file ${binaryPath} not found`,
    ErrBinaryNotFound,
  );
}
