// PTY supervision: the live Session handle and its lifecycle.
//
// A Session owns a harness process running under the Node PTY bridge. It copies
// PTY output into the durable taps (recent-output ring + the OnLine line tap)
// and the caller's stdout, polls the classifier on a fixed cadence, waits for
// the harness to exit (or for Stop / a terminal classification / context
// cancellation to force termination), assembles the final Result, and emits an
// ordered stream of SessionEvents.
//
// This is a faithful port of pkg/wrapper/session.go. Go goroutines + channels
// become async callbacks driven off a single internal event queue, so the
// supervisor stays single-consumer and the emitEvent ordering is preserved.
import { ErrNone } from "./errorclass.js";
import { newLineSplitter } from "./linetap.js";
import { resolveClassifier } from "./classifier.js";
import { newRecentOutput } from "./recentOutput.js";
import { StatusAPIError, StatusBlockedByCost, StatusFailed, StatusIdle, StatusInterrupted, StatusRetryLater, StatusStale, StatusUnknown, StatusWaitingForInput, } from "./status.js";
import { Discard } from "../trace.js";
import { ctxDeadlineExceeded } from "../../internal/async/context.js";
import { isSentinel } from "../../internal/async/errors.js";
function toInternalClassification(c) {
    return {
        status: c.status,
        class: c.class,
        reason: c.reason,
        terminal: c.terminal,
        httpCode: c.httpCode,
        retryAfter: c.retryAfter,
        resumeAt: c.resumeAt,
    };
}
/** Adapt a plain function into a Classifier (the analogue of Go's ClassifierFunc). */
export function ClassifierFunc(fn) {
    return { classify: fn };
}
class Waker {
    items = [];
    resolver = null;
    push(v) {
        if (this.resolver) {
            const r = this.resolver;
            this.resolver = null;
            r(v);
        }
        else {
            this.items.push(v);
        }
    }
    take() {
        const item = this.items.shift();
        if (item !== undefined)
            return Promise.resolve(item);
        return new Promise((res) => {
            this.resolver = res;
        });
    }
}
/**
 * EventChannel mirrors Go's buffered SessionEvent channel: ordered delivery, a
 * bounded buffer, and drop-on-full so a slow consumer can never stall the
 * supervisor. Supports receive() and async iteration; closes after the
 * terminal event.
 */
export class EventChannel {
    capacity;
    buffer = [];
    waiters = [];
    _closed = false;
    constructor(capacity) {
        this.capacity = capacity;
    }
    emit(e) {
        if (this._closed)
            return;
        const w = this.waiters.shift();
        if (w) {
            w({ value: e, ok: true });
            return;
        }
        if (this.buffer.length < this.capacity)
            this.buffer.push(e);
        // else: drop — events are observability, not control flow.
    }
    receive() {
        const item = this.buffer.shift();
        if (item !== undefined)
            return Promise.resolve({ value: item, ok: true });
        if (this._closed)
            return Promise.resolve({ value: undefined, ok: false });
        return new Promise((res) => this.waiters.push(res));
    }
    close() {
        if (this._closed)
            return;
        this._closed = true;
        for (const w of this.waiters.splice(0))
            w({ value: undefined, ok: false });
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const { value, ok } = await this.receive();
            if (!ok)
                return;
            yield value;
        }
    }
}
// ---- Session ---------------------------------------------------------------
const SIGNAL_NAMES = {
    2: "interrupt",
    9: "killed",
    15: "terminated",
};
function signalName(n) {
    return SIGNAL_NAMES[n] ?? `signal ${n}`;
}
function isAsyncIterable(x) {
    return (x != null &&
        typeof x[Symbol.asyncIterator] ===
            "function");
}
function toBytes(chunk) {
    if (typeof chunk === "string")
        return new TextEncoder().encode(chunk);
    if (chunk instanceof Uint8Array)
        return chunk;
    return new Uint8Array(0);
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
export function classifyExit(exit, ctxCancelled, ctxErr) {
    if (ctxCancelled) {
        const sig = exit.signal !== 0 ? signalName(exit.signal) : "";
        return {
            status: StatusInterrupted,
            exitCode: exit.exitCode,
            signal: sig,
            reason: isSentinel(ctxErr, ctxDeadlineExceeded)
                ? "context deadline exceeded"
                : "context cancelled",
        };
    }
    if (exit.exitCode === 0 && exit.signal === 0) {
        return { status: StatusIdle, exitCode: 0, signal: "", reason: "" };
    }
    if (exit.signal !== 0) {
        const sig = signalName(exit.signal);
        return {
            status: StatusInterrupted,
            exitCode: exit.exitCode,
            signal: sig,
            reason: `terminated by ${sig}`,
        };
    }
    return {
        status: StatusFailed,
        exitCode: exit.exitCode,
        signal: "",
        reason: `exit code ${exit.exitCode}`,
    };
}
/**
 * Session is a live handle to a supervised harness process. Construct one with
 * startSession; retrieve the terminal outcome with wait(). stop() requests a
 * graceful shutdown. Concurrent calls to wait, stop, snapshot, and events are
 * safe.
 */
export class Session {
    cfg;
    pty;
    trace;
    classifier;
    recentOutputBuf;
    lineSplitter;
    stdout;
    _startedAt;
    _pid;
    lastOutput = 0;
    q = new Waker();
    _events = new EventChannel(16);
    classifierTimer = null;
    escalateTimer = null;
    terminating = false;
    exitInfo = null;
    endedAt = null;
    stopRequestedFlag = false;
    writerHeld = false;
    snap = { status: "", reason: "", lastOutputAt: null };
    _result = null;
    resolveDone;
    donePromise;
    constructor(args) {
        this.cfg = args.cfg;
        this.pty = args.pty;
        this.trace = args.trace;
        this.classifier = args.classifier;
        this._startedAt = args.startedAt;
        this._pid = args.pty.pid;
        this.recentOutputBuf = newRecentOutput(64 * 1024);
        this.lineSplitter = newLineSplitter(args.cfg.onLine ?? null);
        this.stdout = args.cfg.stdout;
        this.donePromise = new Promise((res) => {
            this.resolveDone = res;
        });
    }
    /** The harness process ID, or 0 if the session never started. */
    pid() {
        return this._pid;
    }
    /** Block until the session terminates; returns the final Result. */
    async wait() {
        await this.donePromise;
        return { result: this._result, err: null };
    }
    /**
     * Request a graceful shutdown (SIGTERM, escalating to SIGKILL after
     * waitDelay). Resolves once the session has terminated or ctx is cancelled.
     * Idempotent.
     */
    async stop(ctx) {
        if (!this.stopRequestedFlag) {
            this.stopRequestedFlag = true;
            this.q.push({ kind: "stop" });
        }
        if (!ctx) {
            await this.donePromise;
            return null;
        }
        const ctxErr = await Promise.race([
            this.donePromise.then(() => null),
            ctx
                .done()
                .then(() => (ctx.err?.() ?? new Error("context cancelled"))),
        ]);
        return ctxErr;
    }
    /** A coherent point-in-time view of the session's state. */
    snapshot() {
        const snap = { ...this.snap };
        if (this.lastOutput > 0)
            snap.lastOutputAt = new Date(this.lastOutput);
        return snap;
    }
    /** The ordered channel of state transitions. Closed after the terminal event. */
    events() {
        return this._events;
    }
    /** A snapshot of the last ~64KB of raw harness PTY output. */
    recentOutput() {
        return this.recentOutputBuf.string();
    }
    /** Forward bytes to the harness PTY (keystrokes). */
    writeStdin(data) {
        this.pty.write(data);
    }
    /** Resize the PTY window. Zero cols/rows are silently rejected. */
    resize(cols, rows) {
        if (cols === 0 || rows === 0)
            return;
        this.pty.resize(cols, rows);
    }
    /**
     * Attempt to claim the exclusive stdin-writer lock. Returns ok=true and a
     * release func when the caller is the active writer; subsequent callers get
     * ok=false and must treat themselves as read-only watchers.
     */
    acquireWriter() {
        if (this.writerHeld) {
            return { release: () => { }, ok: false };
        }
        this.writerHeld = true;
        let released = false;
        return {
            release: () => {
                if (released)
                    return;
                released = true;
                this.writerHeld = false;
            },
            ok: true,
        };
    }
    // --- internal supervision ------------------------------------------------
    /** Begin supervising; wires PTY callbacks and the classifier timer. */
    start(ctx) {
        this.pty.onData((d) => {
            this.onOutput(d);
        });
        this.pty.onExit((e) => {
            if (this.exitInfo)
                return;
            this.exitInfo = e;
            this.endedAt = new Date();
            this.q.push({ kind: "exit" });
        });
        if (ctx) {
            // Capture the cancellation cause (deadline vs cancel) at fire time — the
            // Context sets err() before resolving done() — so classifyExit can tell a
            // real timeout from an abort.
            void ctx.done().then(() => {
                this.q.push({ kind: "ctx", err: ctx.err?.() });
            });
        }
        if (this.cfg.stdin != null) {
            void this.forwardStdin(this.cfg.stdin);
        }
        this.startClassifier();
        void this.supervise();
    }
    /**
     * Forward a Config.stdin source into the harness PTY. Accepts a string,
     * Uint8Array, or any async-iterable byte stream (e.g. a Node Readable). On
     * EOF, sends EOT (Ctrl+D) twice — the first submits any pending unterminated
     * line, the second is read as end-of-file by the PTY's canonical-mode line
     * discipline — mirroring the headless behavior in session.go.
     */
    async forwardStdin(stdin) {
        try {
            if (typeof stdin === "string") {
                this.pty.write(new TextEncoder().encode(stdin));
            }
            else if (stdin instanceof Uint8Array) {
                this.pty.write(stdin);
            }
            else if (isAsyncIterable(stdin)) {
                for await (const chunk of stdin) {
                    this.pty.write(toBytes(chunk));
                }
            }
        }
        catch {
            /* stdin source errored; nothing more to forward */
        }
        finally {
            this.pty.write(new Uint8Array([0x04, 0x04]));
        }
    }
    onOutput(d) {
        this.lastOutput = Date.now();
        this.recentOutputBuf.write(d);
        this.lineSplitter?.write(d);
        this.stdout.write(d);
    }
    terminate() {
        if (this.terminating)
            return;
        this.terminating = true;
        this.pty.kill("SIGTERM");
        this.escalateTimer = setTimeout(() => {
            if (!this.exitInfo)
                this.pty.kill("SIGKILL");
        }, this.cfg.waitDelay);
    }
    async supervise() {
        let terminalClassDone = null;
        let lastErrClass = ErrNone;
        let ctxCancelled = false;
        let ctxErr = undefined;
        for (;;) {
            const ev = await this.q.take();
            if (ev.kind === "exit")
                break;
            if (ev.kind === "class") {
                const c = ev.c;
                if (c.class !== ErrNone)
                    lastErrClass = c.class;
                if (!c.terminal) {
                    this.recordStatusChange(c, false);
                    continue;
                }
                if (this.terminating)
                    continue;
                terminalClassDone = c;
                this.recordStatusChange(c, false);
                this.terminate();
                continue;
            }
            if (ev.kind === "stop") {
                this.stopRequestedFlag = true;
                this.terminate();
                continue;
            }
            if (ev.kind === "ctx") {
                ctxCancelled = true;
                ctxErr = ev.err;
                this.terminate();
                continue;
            }
        }
        if (this.classifierTimer)
            clearInterval(this.classifierTimer);
        if (this.escalateTimer)
            clearTimeout(this.escalateTimer);
        this.lineSplitter?.flush();
        this.pty.closeStdin();
        this.trace.emit({
            at: new Date(),
            kind: "pty_closed",
            fields: { pid: this._pid },
        });
        const exit = this.exitInfo ?? { exitCode: -1, signal: 0 };
        const result = {
            status: StatusUnknown,
            class: ErrNone,
            exitCode: -1,
            signal: "",
            reason: "",
            pid: this._pid,
            startedAt: this._startedAt,
            endedAt: this.endedAt ?? new Date(),
            lastOutputAt: this.lastOutput > 0 ? new Date(this.lastOutput) : null,
        };
        const ce = classifyExit(exit, ctxCancelled, ctxErr);
        result.status = ce.status;
        result.exitCode = ce.exitCode;
        result.signal = ce.signal;
        result.reason = ce.reason;
        // The classification whose structured fields flow into the terminal event:
        // the mid-run terminal classification, or — for a plain failed exit that was
        // not a stop request — a final one-shot pass over recent output.
        let actionable = terminalClassDone;
        if (actionable === null &&
            !this.stopRequestedFlag &&
            result.status === StatusFailed) {
            actionable = this.classifyOnExit();
        }
        if (actionable !== null) {
            result.status = actionable.status;
            result.reason = actionable.reason;
        }
        if (actionable !== null && actionable.class !== ErrNone) {
            result.class = actionable.class;
        }
        else if (result.status === StatusFailed) {
            result.class = lastErrClass;
        }
        if (this.stopRequestedFlag && terminalClassDone === null) {
            result.status = StatusInterrupted;
            if (result.reason === "")
                result.reason = "stop requested";
        }
        this.trace.emit({
            at: new Date(),
            kind: "harness_exited",
            fields: {
                status: result.status,
                exit_code: result.exitCode,
                signal: result.signal,
                reason: result.reason,
                pid: result.pid,
                started_at: result.startedAt,
                ended_at: result.endedAt,
                duration_ms: result.endedAt && result.startedAt
                    ? result.endedAt.getTime() - result.startedAt.getTime()
                    : 0,
            },
        });
        this.snap.status = result.status;
        this.snap.reason = result.reason;
        this._result = result;
        const final = {
            at: new Date(),
            status: result.status,
            class: result.class,
            reason: result.reason,
            terminated: true,
            httpCode: actionable?.httpCode ?? 0,
            retryAfter: actionable?.retryAfter ?? 0,
            resumeAt: actionable?.resumeAt ?? null,
        };
        this._events.emit(final);
        this._events.close();
        this.resolveDone();
    }
    recordStatusChange(c, terminated) {
        if (this.snap.status === c.status && this.snap.reason === c.reason)
            return;
        this.snap.status = c.status;
        this.snap.reason = c.reason;
        this._events.emit({
            at: new Date(),
            status: c.status,
            class: c.class,
            reason: c.reason,
            terminated,
            httpCode: c.httpCode,
            retryAfter: c.retryAfter,
            resumeAt: c.resumeAt,
        });
    }
    classifyOnExit() {
        const c = this.classifier.classify({
            recentOutput: this.recentOutputBuf.string(),
            idle: true,
            quiet: false,
        });
        if (c.status === "" || c.status === StatusWaitingForInput)
            return null;
        return toInternalClassification(c);
    }
    startClassifier() {
        const cfg = this.cfg;
        const tick = Math.max(Math.floor(cfg.idleQuiet / 3), 100);
        const staleEnabled = cfg.staleThreshold > 0;
        let lastSeen = -1;
        let quietEmitted = false;
        let classifyEmitted = false;
        let staleEmitted = false;
        let dispatched = false;
        this.classifierTimer = setInterval(() => {
            const last = this.lastOutput;
            if (last === 0)
                return;
            const outputChanged = last !== lastSeen;
            if (outputChanged) {
                lastSeen = last;
                quietEmitted = false;
                classifyEmitted = false;
                staleEmitted = false;
            }
            const sinceLast = Date.now() - last;
            const quiet = !outputChanged && sinceLast >= cfg.idleQuiet;
            const idle = !outputChanged && sinceLast >= cfg.idleClassify;
            const stale = !outputChanged && staleEnabled && sinceLast >= cfg.staleThreshold;
            if (quiet && !quietEmitted) {
                this.trace.emit({
                    at: new Date(),
                    kind: "output_quiet",
                    fields: {
                        since_last_output_ms: sinceLast,
                        threshold_ms: cfg.idleQuiet,
                    },
                });
                quietEmitted = true;
            }
            if (idle && !classifyEmitted) {
                this.trace.emit({
                    at: new Date(),
                    kind: "output_classify_threshold",
                    fields: {
                        since_last_output_ms: sinceLast,
                        threshold_ms: cfg.idleClassify,
                    },
                });
                classifyEmitted = true;
            }
            if (stale && !staleEmitted) {
                this.trace.emit({
                    at: new Date(),
                    kind: "harness_stale",
                    fields: {
                        since_last_output_ms: sinceLast,
                        threshold_ms: cfg.staleThreshold,
                    },
                });
                this.recordStatusChange({
                    status: StatusStale,
                    class: ErrNone,
                    reason: `no output for ${Math.round(sinceLast / 1000)}s`,
                    terminal: false,
                    httpCode: 0,
                    retryAfter: 0,
                    resumeAt: null,
                }, false);
                staleEmitted = true;
            }
            if (dispatched)
                return;
            const classification = this.classifier.classify({
                recentOutput: this.recentOutputBuf.string(),
                sinceLastOutput: sinceLast,
                quiet,
                idle,
            });
            if (classification.status === "")
                return;
            this.emitClassifierTrace(classification);
            this.q.push({
                kind: "class",
                c: toInternalClassification(classification),
            });
            if (classification.terminal)
                dispatched = true;
        }, tick);
    }
    emitClassifierTrace(c) {
        let kind = "harness_classified";
        switch (c.status) {
            case StatusBlockedByCost:
                kind = "harness_blocked_by_cost";
                break;
            case StatusRetryLater:
                kind = "harness_retry_later";
                break;
            case StatusWaitingForInput:
                kind = "harness_waiting_for_input";
                break;
            case StatusAPIError:
                kind = "harness_api_error";
                break;
        }
        const fields = {
            status: c.status,
            reason: c.reason,
            terminal: c.terminal,
        };
        if (c.httpCode !== 0)
            fields.http_code = c.httpCode;
        if (c.retryAfter > 0)
            fields.retry_after_ms = c.retryAfter;
        if (c.resumeAt)
            fields.resume_at = c.resumeAt.toISOString();
        this.trace.emit({ at: new Date(), kind, fields });
    }
}
/** Apply per-field defaults to a config (mirrors Go's applyDefaults). */
export function applyDefaults(cfg) {
    if (!cfg.idleQuiet)
        cfg.idleQuiet = 15_000;
    if (!cfg.idleClassify)
        cfg.idleClassify = 60_000;
    if (!cfg.staleThreshold)
        cfg.staleThreshold = 5 * 60_000;
    if (!cfg.waitDelay)
        cfg.waitDelay = 5_000;
}
/** Construct a Session for an already-validated, defaulted config. */
export async function startSession(cfg, pty, ctx) {
    const trace = cfg.trace ?? Discard;
    const startedAt = new Date();
    trace.emit({ at: startedAt, kind: "pty_opened", fields: { pid: pty.pid } });
    const session = new Session({
        cfg,
        pty,
        trace,
        classifier: resolveClassifier(cfg.harness ?? "", cfg.classifier),
        startedAt,
    });
    session.start(ctx);
    return session;
}
//# sourceMappingURL=session.js.map