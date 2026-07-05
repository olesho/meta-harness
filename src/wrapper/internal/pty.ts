// The parent-side PTY abstraction.
//
// node-pty's native read loop is dead under Bun, so the wrapper never talks to
// node-pty directly. Instead it spawns a small Node bridge (ptyHost.mjs) that
// owns the real PTY and proxies it over an ordinary stdio pipe — which Bun
// reads fine. PtyProcess hides the bridge behind a node-pty-shaped surface:
// onData / onExit callbacks plus write / resize / kill.

import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { defineSentinel, type Sentinel, wrap } from "../../internal/async/errors.ts"
import { ErrBinaryNotFound } from "./config.ts"

/** PTY allocation failed (bridge could not be spawned or the harness PTY died on open). */
export const ErrPTYAllocation: Sentinel = defineSentinel(
  "wrapper:pty-allocation",
  "wrapper: pty allocation failed",
)
/** A read on the PTY master failed. */
export const ErrPTYRead: Sentinel = defineSentinel(
  "wrapper:pty-read",
  "wrapper: pty read failed",
)

/**
 * Resolve the PTY bridge path. By default it sits next to this module, but when
 * this module is bundled (e.g. esbuild inlines it into a consumer's server.mjs),
 * `import.meta.url` points at the bundle — not at ptyHost.mjs. Consumers that
 * relocate the bridge set META_HARNESS_PTY_HOST to its absolute path. Resolved
 * lazily at spawn time (not module-eval), so the override only needs to be in the
 * environment before {@link PtyProcess.spawn} runs — no import-order constraint.
 */
export function resolveHost(): string {
  const override = process.env.META_HARNESS_PTY_HOST?.trim()
  if (override) return override
  return join(dirname(fileURLToPath(import.meta.url)), "ptyHost.mjs")
}

const T_READY = "r".charCodeAt(0)
const T_OUTPUT = "o".charCodeAt(0)
const T_EXIT = "x".charCodeAt(0)
const T_STDIN = "i".charCodeAt(0)
const T_RESIZE = "w".charCodeAt(0)
const T_KILL = "k".charCodeAt(0)

/** The exit observation the bridge forwards from node-pty's onExit. */
export interface PtyExit {
  exitCode: number
  signal: number
}

export interface PtySpawnOptions {
  binaryPath: string
  args: string[]
  cwd?: string
  /** Environment as an object, or undefined to inherit the parent's. */
  env?: Record<string, string>
  cols?: number
  rows?: number
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = type
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

/**
 * PtyProcess is a live handle to a harness running under the Node PTY bridge.
 * Construct with PtyProcess.spawn, which resolves once the bridge reports the
 * harness PID (or rejects if the bridge could not start).
 */
export class PtyProcess {
  private readonly child: ChildProcess
  private _pid = 0
  private _exited = false
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private dataCb: ((d: Uint8Array) => void) | null = null
  private exitCb: ((e: PtyExit) => void) | null = null

  private constructor(child: ChildProcess) {
    this.child = child
  }

  /** The harness process PID (0 until the bridge reports ready). */
  get pid(): number {
    return this._pid
  }

  /**
   * Spawn the bridge and the harness under it. Resolves with a live PtyProcess
   * once the harness PID is known; rejects (wrapping ErrPTYAllocation) if the
   * bridge dies before reporting ready.
   */
  static spawn(opts: PtySpawnOptions): Promise<PtyProcess> {
    const child = spawn("node", [resolveHost(), JSON.stringify(opts)], {
      stdio: ["pipe", "pipe", "inherit"],
    })
    const p = new PtyProcess(child)

    return new Promise<PtyProcess>((resolve, reject) => {
      let settled = false
      const onReady = (pid: number) => {
        if (settled) return
        settled = true
        p._pid = pid
        resolve(p)
      }
      const onEarlyExit = (err: unknown) => {
        if (settled) return
        settled = true
        reject(wrap("wrapper: pty allocation failed", err ?? ErrPTYAllocation))
      }

      p.readyResolver = onReady
      child.on("error", onEarlyExit)
      child.on("exit", () => {
        if (!settled) onEarlyExit(ErrPTYAllocation)
      })
      child.stdout?.on("data", (chunk: Buffer) => p.feed(chunk))
    })
  }

  private readyResolver: ((pid: number) => void) | null = null

  private feed(chunk: Uint8Array): void {
    this.buf =
      this.buf.length === 0 ? chunk : concat(this.buf, chunk)
    for (;;) {
      if (this.buf.length < 5) break
      const type = this.buf[0]!
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      ).getUint32(1, false)
      if (this.buf.length < 5 + len) break
      const payload = this.buf.subarray(5, 5 + len)
      const rest = this.buf.slice(5 + len)
      this.handle(type, payload)
      this.buf = rest
    }
  }

  private handle(type: number, payload: Uint8Array): void {
    switch (type) {
      case T_READY: {
        const { pid } = JSON.parse(decode(payload))
        this.readyResolver?.(pid)
        this.readyResolver = null
        break
      }
      case T_OUTPUT:
        this.dataCb?.(payload)
        break
      case T_EXIT: {
        if (this._exited) break
        this._exited = true
        const e = JSON.parse(decode(payload))
        this.exitCb?.({ exitCode: e.exitCode ?? -1, signal: e.signal ?? 0 })
        break
      }
    }
  }

  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (e: PtyExit) => void): void {
    this.exitCb = cb
  }

  /** Forward bytes to the harness PTY (keystrokes). */
  write(data: Uint8Array): void {
    if (this._exited) return
    this.send(T_STDIN, data)
  }

  /** Resize the PTY window. */
  resize(cols: number, rows: number): void {
    if (this._exited) return
    this.send(T_RESIZE, encode(JSON.stringify({ cols, rows })))
  }

  /** Send a signal to the harness (e.g. "SIGTERM", "SIGKILL"). */
  kill(signal: string): void {
    if (this._exited) return
    this.send(T_KILL, encode(JSON.stringify({ signal })))
  }

  /** Close the bridge's control channel; tears the harness down if still alive. */
  closeStdin(): void {
    this.child.stdin?.end()
  }

  private send(type: number, payload: Uint8Array): void {
    this.child.stdin?.write(Buffer.from(frame(type, payload)))
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * Resolve a harness binary the way exec.LookPath would: an absolute or
 * path-bearing name is checked for existence + executability directly; a bare
 * name is searched on PATH. Returns the resolved path, or null when the binary
 * is not found. The wrapper preflights this so Start can return
 * ErrBinaryNotFound before ever spawning the bridge — node-pty only surfaces a
 * missing binary as an opaque exit(1), which is indistinguishable from a real
 * harness failure.
 */
export function resolveBinary(
  binaryPath: string,
  env?: Record<string, string>,
): string | null {
  if (isAbsolute(binaryPath) || binaryPath.includes("/")) {
    return isExecutable(binaryPath) ? binaryPath : null
  }
  const pathVar = (env?.PATH ?? process.env.PATH ?? "").split(delimiter)
  for (const dir of pathVar) {
    if (dir === "") continue
    const candidate = join(dir, binaryPath)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Build the cause-chain error Start returns for a missing harness binary. */
export function binaryNotFoundError(binaryPath: string): Error {
  return wrap(
    `wrapper: binary not found: executable file ${binaryPath} not found`,
    ErrBinaryNotFound,
  )
}
