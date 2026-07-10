import { type Sentinel } from "../../internal/async/errors.ts";
/** PTY allocation failed (bridge could not be spawned or the harness PTY died on open). */
export declare const ErrPTYAllocation: Sentinel;
/** A read on the PTY master failed. */
export declare const ErrPTYRead: Sentinel;
/**
 * The Node interpreter that runs the PTY bridge could not be found. The bridge
 * is spawned by name ("node") unless a real interpreter is resolvable; when the
 * gate shell has no `node` on PATH the spawn fails ENOENT. Distinguishing this
 * from a genuine {@link ErrPTYAllocation} keeps a missing interpreter from being
 * mis-reported as a PTY failure (META-HARNESS-34).
 */
export declare const ErrNodeNotFound: Sentinel;
/**
 * Resolve the PTY bridge path. By default it sits next to this module, but when
 * this module is bundled (e.g. esbuild inlines it into a consumer's server.mjs),
 * `import.meta.url` points at the bundle — not at ptyHost.mjs. Consumers that
 * relocate the bridge set META_HARNESS_PTY_HOST to its absolute path. Resolved
 * lazily at spawn time (not module-eval), so the override only needs to be in the
 * environment before {@link PtyProcess.spawn} runs — no import-order constraint.
 */
export declare function resolveHost(): string;
/**
 * Locate a real Node interpreter without falling back to a bare name. Resolution
 * order: `META_HARNESS_NODE` → `node` on PATH → the active nvm install →
 * {@link COMMON_NODE_PATHS}. Returns the absolute path, or null when nothing
 * resolves (so callers — e.g. the test preload — can fail loudly). Every
 * candidate is existence/executability checked before it is returned.
 */
export declare function findNode(env?: Record<string, string>): string | null;
/**
 * Resolve the interpreter used to spawn the PTY bridge (and, in tests, the
 * `#!/usr/bin/env node` fake harness). In production the wrapper runs under Node,
 * so it reuses `process.execPath` — the same interpreter, zero PATH lookup. Only
 * when running under Bun (e.g. `bun test`, where `process.execPath` is bun) does
 * it hunt for a real `node`, falling back to the bare name so the spawn still
 * attempts and a miss surfaces as {@link ErrNodeNotFound}. `META_HARNESS_NODE`
 * always wins, even under Node, for callers that must pin a specific interpreter.
 */
export declare function resolveNode(env?: Record<string, string>): string;
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
/**
 * PtyProcess is a live handle to a harness running under the Node PTY bridge.
 * Construct with PtyProcess.spawn, which resolves once the bridge reports the
 * harness PID (or rejects if the bridge could not start).
 */
export declare class PtyProcess {
    private readonly child;
    private _pid;
    private _exited;
    private buf;
    private dataCb;
    private exitCb;
    private constructor();
    /** The harness process PID (0 until the bridge reports ready). */
    get pid(): number;
    /**
     * Spawn the bridge and the harness under it. Resolves with a live PtyProcess
     * once the harness PID is known; rejects (wrapping ErrPTYAllocation) if the
     * bridge dies before reporting ready.
     */
    static spawn(opts: PtySpawnOptions): Promise<PtyProcess>;
    private readyResolver;
    private feed;
    private handle;
    onData(cb: (d: Uint8Array) => void): void;
    onExit(cb: (e: PtyExit) => void): void;
    /** Forward bytes to the harness PTY (keystrokes). */
    write(data: Uint8Array): void;
    /** Resize the PTY window. */
    resize(cols: number, rows: number): void;
    /** Send a signal to the harness (e.g. "SIGTERM", "SIGKILL"). */
    kill(signal: string): void;
    /** Close the bridge's control channel; tears the harness down if still alive. */
    closeStdin(): void;
    private send;
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
export declare function resolveBinary(binaryPath: string, env?: Record<string, string>): string | null;
/** Build the cause-chain error Start returns for a missing harness binary. */
export declare function binaryNotFoundError(binaryPath: string): Error;
//# sourceMappingURL=pty.d.ts.map