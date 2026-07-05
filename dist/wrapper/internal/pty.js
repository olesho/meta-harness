// The parent-side PTY abstraction.
//
// node-pty's native read loop is dead under Bun, so the wrapper never talks to
// node-pty directly. Instead it spawns a small Node bridge (ptyHost.mjs) that
// owns the real PTY and proxies it over an ordinary stdio pipe — which Bun
// reads fine. PtyProcess hides the bridge behind a node-pty-shaped surface:
// onData / onExit callbacks plus write / resize / kill.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineSentinel, wrap } from "../../internal/async/errors.js";
import { ErrBinaryNotFound } from "./config.js";
/** PTY allocation failed (bridge could not be spawned or the harness PTY died on open). */
export const ErrPTYAllocation = defineSentinel("wrapper:pty-allocation", "wrapper: pty allocation failed");
/** A read on the PTY master failed. */
export const ErrPTYRead = defineSentinel("wrapper:pty-read", "wrapper: pty read failed");
/**
 * Resolve the PTY bridge path. By default it sits next to this module, but when
 * this module is bundled (e.g. esbuild inlines it into a consumer's server.mjs),
 * `import.meta.url` points at the bundle — not at ptyHost.mjs. Consumers that
 * relocate the bridge set META_HARNESS_PTY_HOST to its absolute path. Resolved
 * lazily at spawn time (not module-eval), so the override only needs to be in the
 * environment before {@link PtyProcess.spawn} runs — no import-order constraint.
 */
export function resolveHost() {
    const override = process.env.META_HARNESS_PTY_HOST?.trim();
    if (override)
        return override;
    return join(dirname(fileURLToPath(import.meta.url)), "ptyHost.mjs");
}
const T_READY = "r".charCodeAt(0);
const T_OUTPUT = "o".charCodeAt(0);
const T_EXIT = "x".charCodeAt(0);
const T_STDIN = "i".charCodeAt(0);
const T_RESIZE = "w".charCodeAt(0);
const T_KILL = "k".charCodeAt(0);
function frame(type, payload) {
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
    child;
    _pid = 0;
    _exited = false;
    buf = new Uint8Array(0);
    dataCb = null;
    exitCb = null;
    constructor(child) {
        this.child = child;
    }
    /** The harness process PID (0 until the bridge reports ready). */
    get pid() {
        return this._pid;
    }
    /**
     * Spawn the bridge and the harness under it. Resolves with a live PtyProcess
     * once the harness PID is known; rejects (wrapping ErrPTYAllocation) if the
     * bridge dies before reporting ready.
     */
    static spawn(opts) {
        const child = spawn("node", [resolveHost(), JSON.stringify(opts)], {
            stdio: ["pipe", "pipe", "inherit"],
        });
        const p = new PtyProcess(child);
        return new Promise((resolve, reject) => {
            let settled = false;
            const onReady = (pid) => {
                if (settled)
                    return;
                settled = true;
                p._pid = pid;
                resolve(p);
            };
            const onEarlyExit = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(wrap("wrapper: pty allocation failed", err ?? ErrPTYAllocation));
            };
            p.readyResolver = onReady;
            child.on("error", onEarlyExit);
            child.on("exit", () => {
                if (!settled)
                    onEarlyExit(ErrPTYAllocation);
            });
            child.stdout?.on("data", (chunk) => p.feed(chunk));
        });
    }
    readyResolver = null;
    feed(chunk) {
        this.buf =
            this.buf.length === 0 ? chunk : concat(this.buf, chunk);
        for (;;) {
            if (this.buf.length < 5)
                break;
            const type = this.buf[0];
            const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(1, false);
            if (this.buf.length < 5 + len)
                break;
            const payload = this.buf.subarray(5, 5 + len);
            const rest = this.buf.slice(5 + len);
            this.handle(type, payload);
            this.buf = rest;
        }
    }
    handle(type, payload) {
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
                if (this._exited)
                    break;
                this._exited = true;
                const e = JSON.parse(decode(payload));
                this.exitCb?.({ exitCode: e.exitCode ?? -1, signal: e.signal ?? 0 });
                break;
            }
        }
    }
    onData(cb) {
        this.dataCb = cb;
    }
    onExit(cb) {
        this.exitCb = cb;
    }
    /** Forward bytes to the harness PTY (keystrokes). */
    write(data) {
        if (this._exited)
            return;
        this.send(T_STDIN, data);
    }
    /** Resize the PTY window. */
    resize(cols, rows) {
        if (this._exited)
            return;
        this.send(T_RESIZE, encode(JSON.stringify({ cols, rows })));
    }
    /** Send a signal to the harness (e.g. "SIGTERM", "SIGKILL"). */
    kill(signal) {
        if (this._exited)
            return;
        this.send(T_KILL, encode(JSON.stringify({ signal })));
    }
    /** Close the bridge's control channel; tears the harness down if still alive. */
    closeStdin() {
        this.child.stdin?.end();
    }
    send(type, payload) {
        this.child.stdin?.write(Buffer.from(frame(type, payload)));
    }
}
function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function decode(b) {
    return new TextDecoder().decode(b);
}
function encode(s) {
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
 */
export function resolveBinary(binaryPath, env) {
    if (isAbsolute(binaryPath) || binaryPath.includes("/")) {
        return isExecutable(binaryPath) ? binaryPath : null;
    }
    const pathVar = (env?.PATH ?? process.env.PATH ?? "").split(delimiter);
    for (const dir of pathVar) {
        if (dir === "")
            continue;
        const candidate = join(dir, binaryPath);
        if (isExecutable(candidate))
            return candidate;
    }
    return null;
}
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
/** Build the cause-chain error Start returns for a missing harness binary. */
export function binaryNotFoundError(binaryPath) {
    return wrap(`wrapper: binary not found: executable file ${binaryPath} not found`, ErrBinaryNotFound);
}
//# sourceMappingURL=pty.js.map