import { type Classification, type Classifier, type ClassifierInput } from "./classification.ts";
import { type Config } from "./config.ts";
import { type ErrorClass } from "./errorclass.ts";
import { PtyProcess, type PtyExit } from "./pty.ts";
import { type Status } from "./status.ts";
import { type Emitter } from "../trace.ts";
/** A sink the wrapper writes raw PTY bytes to (the Config.stdout target). */
export interface StdoutSink {
    write(data: Uint8Array): unknown;
}
/** Most-recent state observation for a Session. */
export interface Snapshot {
    status: Status;
    reason: string;
    /** Time of the most recent PTY byte, or null if none observed. */
    lastOutputAt: Date | null;
}
/** A state transition observed by a Session, delivered in order on events(). */
export interface SessionEvent {
    at: Date;
    status: Status;
    reason: string;
    terminated: boolean;
    class: ErrorClass;
    httpCode: number;
    /** Suggested retry wait in ms, or 0. */
    retryAfter: number;
    resumeAt: Date | null;
}
/** The terminal outcome of a run. */
export interface Result {
    status: Status;
    class: ErrorClass;
    exitCode: number;
    signal: string;
    reason: string;
    pid: number;
    startedAt: Date | null;
    endedAt: Date | null;
    lastOutputAt: Date | null;
}
/** Adapt a plain function into a Classifier (the analogue of Go's ClassifierFunc). */
export declare function ClassifierFunc(fn: (input: ClassifierInput) => Classification): Classifier;
/** Receipt of a value: ok=false once the channel is closed and drained. */
export interface EventRecv {
    value: SessionEvent | undefined;
    ok: boolean;
}
/**
 * EventChannel mirrors Go's buffered SessionEvent channel: ordered delivery, a
 * bounded buffer, and drop-on-full so a slow consumer can never stall the
 * supervisor. Supports receive() and async iteration; closes after the
 * terminal event.
 */
export declare class EventChannel {
    private readonly capacity;
    private buffer;
    private waiters;
    private _closed;
    constructor(capacity: number);
    emit(e: SessionEvent): void;
    receive(): Promise<EventRecv>;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<SessionEvent>;
}
/**
 * classifyExit maps a finished PTY process into the wrapper's normalized
 * status. When the run's context was cancelled it is considered interrupted
 * regardless of how the child happened to exit.
 *
 * `ctxErr` is the context's cancellation cause, when known. A deadline expiry
 * (ctxDeadlineExceeded) surfaces reason "context deadline exceeded"; every other
 * cancel (explicit cancel / an abort adapter / an unknown cause) stays "context
 * cancelled". Callers rely on this to tell a real timeout from an abort — e.g.
 * the orchestrator synthesizes exit-124 only for the deadline wording.
 */
export declare function classifyExit(exit: PtyExit, ctxCancelled: boolean, ctxErr?: unknown): {
    status: Status;
    exitCode: number;
    signal: string;
    reason: string;
};
/**
 * Session is a live handle to a supervised harness process. Construct one with
 * startSession; retrieve the terminal outcome with wait(). stop() requests a
 * graceful shutdown. Concurrent calls to wait, stop, snapshot, and events are
 * safe.
 */
export declare class Session {
    private readonly cfg;
    private readonly pty;
    private readonly trace;
    private readonly classifier;
    private readonly recentOutputBuf;
    private readonly lineSplitter;
    private readonly stdout;
    private readonly _startedAt;
    private _pid;
    private lastOutput;
    private readonly q;
    private readonly _events;
    private classifierTimer;
    private escalateTimer;
    private terminating;
    private exitInfo;
    private endedAt;
    private stopRequestedFlag;
    private writerHeld;
    private snap;
    private _result;
    private resolveDone;
    private readonly donePromise;
    constructor(args: {
        cfg: Config;
        pty: PtyProcess;
        trace: Emitter;
        classifier: Classifier;
        startedAt: Date;
    });
    /** The harness process ID, or 0 if the session never started. */
    pid(): number;
    /** Block until the session terminates; returns the final Result. */
    wait(): Promise<{
        result: Result;
        err: Error | null;
    }>;
    /**
     * Request a graceful shutdown (SIGTERM, escalating to SIGKILL after
     * waitDelay). Resolves once the session has terminated or ctx is cancelled.
     * Idempotent.
     */
    stop(ctx?: {
        done(): Promise<void>;
        err?: () => unknown;
    }): Promise<Error | null>;
    /** A coherent point-in-time view of the session's state. */
    snapshot(): Snapshot;
    /** The ordered channel of state transitions. Closed after the terminal event. */
    events(): EventChannel;
    /** A snapshot of the last ~64KB of raw harness PTY output. */
    recentOutput(): string;
    /** Forward bytes to the harness PTY (keystrokes). */
    writeStdin(data: Uint8Array): void;
    /** Resize the PTY window. Zero cols/rows are silently rejected. */
    resize(cols: number, rows: number): void;
    /**
     * Attempt to claim the exclusive stdin-writer lock. Returns ok=true and a
     * release func when the caller is the active writer; subsequent callers get
     * ok=false and must treat themselves as read-only watchers.
     */
    acquireWriter(): {
        release: () => void;
        ok: boolean;
    };
    /** Begin supervising; wires PTY callbacks and the classifier timer. */
    start(ctx?: {
        done(): Promise<void>;
        err?(): unknown;
    }): void;
    /**
     * Forward a Config.stdin source into the harness PTY. Accepts a string,
     * Uint8Array, or any async-iterable byte stream (e.g. a Node Readable). On
     * EOF, sends EOT (Ctrl+D) twice — the first submits any pending unterminated
     * line, the second is read as end-of-file by the PTY's canonical-mode line
     * discipline — mirroring the headless behavior in session.go.
     */
    private forwardStdin;
    private onOutput;
    private terminate;
    private supervise;
    private recordStatusChange;
    private classifyOnExit;
    private startClassifier;
    private emitClassifierTrace;
}
/** Apply per-field defaults to a config (mirrors Go's applyDefaults). */
export declare function applyDefaults(cfg: Config): void;
/** Construct a Session for an already-validated, defaulted config. */
export declare function startSession(cfg: Config, pty: PtyProcess, ctx?: {
    done(): Promise<void>;
    err?(): unknown;
}): Promise<Session>;
//# sourceMappingURL=session.d.ts.map