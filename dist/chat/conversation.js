// Conversation — the top of the core. The TS port of pkg/chat (conversation.go,
// send.go, input.go). A Conversation owns one PTY-supervised harness process and
// serves the chat-style API on top of it: acquire exclusive control, send a user
// message, observe turn-state transitions, answer interactive prompts.
//
// It consumes the Phase-4 wrapper surfaces directly (wrapper.start / Session) and
// the Phase-3 turns Watcher + per-harness adapters. It does NOT reimplement
// supervision.
//
// JavaScript is single-threaded, so the Go mutex around currentTurn / session is
// unnecessary: every read-modify-write below runs to completion without an
// interleaving await. The event pump, the idle-completion loop, and caller
// methods cooperate on the microtask/timer queue, not on real threads.
import { newScreen } from "../screen/index.js";
import { Watch, TurnComplete, ToolCall, Blocked, Errored, InputRequested, InputResolved, generic, claudecode, codex, opencode, pi, } from "../turns/index.js";
import { start as wrapperStart, } from "../wrapper/index.js";
import { Context, isSentinel, wrap } from "../internal/async/index.js";
import { ErrEmptySessionID, ErrSessionNotFound } from "../transcript/errors.js";
import { stripIDEContextTags } from "../transcript/stripTags.js";
import { RoleUser, RoleAssistant, TurnStatePending, TurnStateComplete, TurnStateErrored, EventTurn, EventInputRequest, EventInputResolved, DispositionAnswer, DispositionDeny, HistorySourceTranscript, HistorySourceStore, newID, } from "./types.js";
import { ErrInvalidOptions, ErrUnknownHarness, ErrNoControl, ErrTurnInFlight, ErrClosed, ErrInputPending, ErrNoInputPending, ErrStaleInputRequest, ErrUnknownOption, ErrNotMultiSelect, ErrQuitUnsupported, ErrResumeUnsupported, ErrNoHarnessSession, } from "./errors.js";
import { newControlQueue } from "./control.js";
import { submitKeyForHarness, requiresPromptReadiness, readyForInput, } from "./ready.js";
import { cleanHarnessEnv } from "./env.js";
import { AcquisitionModeOff, AcquisitionModeHooks } from "../turns/index.js";
import { StreamTap, adapterStreamParser, } from "../acquisition/internal/streamTap.js";
import { newDisplaySink } from "../acquisition/internal/display.js";
import { hookEnv } from "../acquisition/internal/yield.js";
import { planAcquisition, resolveProfile, } from "../acquisition/internal/planAcquisition.js";
import { HookDrain } from "./hookDrain.js";
import { EnvConfigDir, EnvSessionID } from "../cli/hooks.js";
const enc = new TextEncoder();
// idleCompletionGap — how long the screen must sit unchanged at the ready prompt
// before the idle fallback completes an in-flight turn. (ms)
const idleCompletionGap = 8000;
// markerConfirmGap — the shorter quiet window used once an end-of-turn marker has
// been seen. (ms)
const markerConfirmGap = 2000;
// primeBoundGap — the overall wall-clock bound on the startup session-id prime,
// so Open can never hang on the /status scrape. (ms)
const primeBoundGap = 800;
// submitEchoGap — the wall-clock bound on the wait between writing a message's
// text and writing its submit key, while the composer echoes the text. (ms)
const submitEchoGap = 1500;
// echoNeedleLen — how much of the message's first line the echo wait matches
// on. Short enough that the composer cannot soft-wrap it mid-needle at any
// supported terminal width.
const echoNeedleLen = 24;
// transcriptFlushRetryGap — the one-shot re-read delay when the swallow-override
// transcript proof misses in a flush-lag shape (no rollout on disk yet, or the
// current prompt not yet appended). A genuine swallow writes no rollout, so it
// pays at most this once. (ms)
const transcriptFlushRetryGap = 500;
// DefaultActivityInterval — the activity observer's default tick period, mirroring
// Go's harness.DefaultActivityInterval (10s). Used when Options.activityInterval
// is undefined or <= 0. (ms)
export const DefaultActivityInterval = 10_000;
function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
/** A size-1 coalesced wake signal — the Go `chan struct{}` of capacity 1. */
class Signal {
    pending = false;
    waiter = null;
    signal() {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w();
            return;
        }
        this.pending = true;
    }
    receive() {
        if (this.pending) {
            this.pending = false;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.waiter = resolve;
        });
    }
    /** Non-blocking drain — true if a signal was pending (the select default). */
    tryReceive() {
        if (this.pending) {
            this.pending = false;
            return true;
        }
        return false;
    }
}
/** A buffered chat-event channel: emit drops when full; receive/tryReceive read. */
class EventBus {
    cap;
    buf = [];
    recvWaiters = [];
    _closed = false;
    constructor(cap) {
        this.cap = cap;
    }
    /** Non-blocking push; drops the event when the buffer is full (Go's emit). */
    emit(ev) {
        if (this._closed)
            return;
        const w = this.recvWaiters.shift();
        if (w) {
            w({ value: ev, ok: true });
            return;
        }
        if (this.buf.length >= this.cap)
            return;
        this.buf.push(ev);
    }
    /** Synchronous, non-blocking receive — the Go `select { case <-ch: default }`. */
    tryReceive() {
        if (this.buf.length > 0)
            return { value: this.buf.shift(), ok: true };
        return { value: undefined, ok: false };
    }
    receive() {
        if (this.buf.length > 0)
            return Promise.resolve({ value: this.buf.shift(), ok: true });
        if (this._closed)
            return Promise.resolve({ value: undefined, ok: false });
        return new Promise((resolve) => this.recvWaiters.push(resolve));
    }
    close() {
        if (this._closed)
            return;
        this._closed = true;
        for (const w of this.recvWaiters.splice(0))
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
export class Conversation {
    opts;
    store;
    adapter;
    sess;
    screen;
    watcher;
    releaseWriter;
    queue;
    session;
    /**
     * The final run-level observation, captured off the watcher AFTER
     * consumeWatcher's event loop drains the terminal event (the post-terminal
     * seam — watcher.close() is NOT a valid barrier; it only joins the screen
     * pump). Rolls up the LARGEST retryAfter and whether ANY raw wrapper event
     * reported an api_error, EVEN one that produced no turn transition. Defaults
     * to the empty observation until the loop completes. Ports Go's Result
     * observation (pkg/harness/run.go).
     */
    finalObservation = {
        retryAfter: 0,
        sawAPIError: false,
    };
    /**
     * The per-run acquisition tap: a PARALLEL CONSUMER of the same durable PTY line
     * tap `captureRawSessionID` reads from. Set by openWithSession when the plan or
     * a display sink needs it; otherwise undefined. Never drives turn state.
     */
    streamTap;
    /**
     * Resume-only, one-shot latch. Armed by openWithSession ONLY when the session
     * was seeded from an Options.resume id AND the resolved adapter reports
     * resumeForksSessionID() === true (i.e. `resume` mints a NEW harness session id
     * rather than continuing the old one). While set, maybeExtractSessionID is
     * allowed to overwrite the seeded (now-stale) id EXACTLY ONCE with the freshly
     * located id, after which it clears itself. It never arms for non-forking
     * harnesses (Claude Code, Codex per the verified finding), so the general
     * first-write-wins guards remain in force for every other session.
     */
    harnessSessionIDProvisional = false;
    /**
     * Outcome of the startup session-id prime (primeSessionID). Undefined when
     * priming did not run (resume, non-codex, id already set). NOT a public
     * accessor and NOT walked by the contract golden (private instance field);
     * tests read it via a structural escape.
     *
     * Load-bearing (not merely diagnostic) on the codex first-write path: the
     * `written_uncaptured` value ARMS the guarded disk fallback. maybeExtractSessionID's
     * first-write branch passes `primeOutcome === "written_uncaptured"` as
     * extractSessionID's allowDiskFallback, so this field decides whether the
     * disk-locate backstop (CodexAdapter.locateSessionID) is consulted at all. Any
     * other value (or undefined) keeps the fallback OFF — the scrape either worked,
     * was never primed, or is still viable. See extractSessionID.
     */
    primeOutcome;
    eventCh;
    currentTurn = null;
    endMarkerSeen = false;
    /** Rendered screen at the moment send() submitted the in-flight prompt. */
    sentScreenText = "";
    /** Raw prompt text of the in-flight send (transcript swallow-override proof). */
    sentPromptText = "";
    /**
     * Transcript turn count captured just before the in-flight submit, or null
     * when unknown. The swallow-override proof only accepts a prompt match at an
     * index ≥ this watermark, so an identical prompt earlier in a resumed rollout
     * can never count as proof of the CURRENT turn (turnsFromEvents carries no
     * turn boundaries). Computed only for transcript-override-eligible adapters.
     */
    sentTranscriptWatermark = null;
    markerArmCh;
    inputStateCh;
    /**
     * The hook drain's independent wake Signal (same primitive as markerArmCh).
     * The spool fs-watch raises it; the drain loop receives it, racing it against
     * the close promise and a BOUNDED fallback timer — so a missed wake can never
     * wedge the tail. Distinct from markerArmCh: hook-event latency is NOT coupled
     * to the turn watcher yielding a live/file event.
     */
    hookDrainCh;
    /** The active hook drain, when the run opted in AND the adapter supports hooks. */
    hookDrain;
    currentInput = null;
    inputSurfaced = false;
    writeStdin;
    closedFlag = false;
    closedResolve;
    closedPromise;
    closeDone = false;
    constructor(init = {}) {
        this.opts = {
            harness: "",
            binaryPath: "",
            store: undefined,
            ...init.opts,
        };
        if (init.store)
            this.store = init.store;
        if (init.adapter)
            this.adapter = init.adapter;
        if (init.sess)
            this.sess = init.sess;
        this.screen = init.screen ?? undefined;
        this.watcher = init.watcher;
        this.queue = init.queue ?? newControlQueue();
        this.session = init.session ?? {
            id: "",
            harness: this.opts.harness,
            workingDir: this.opts.workingDir ?? "",
            createdAt: new Date(),
            harnessSessionID: "",
        };
        this.eventCh =
            init.eventCh ??
                new EventBus(this.opts.eventBuffer && this.opts.eventBuffer > 0
                    ? this.opts.eventBuffer
                    : 32);
        this.currentTurn = init.currentTurn ?? null;
        this.markerArmCh = init.markerArmCh ?? new Signal();
        this.inputStateCh = init.inputStateCh ?? new Signal();
        this.hookDrainCh = init.hookDrainCh ?? new Signal();
        this.writeStdin = init.writeStdin;
        this.closedPromise = new Promise((resolve) => {
            this.closedResolve = resolve;
        });
        if (init.closed) {
            this.closedFlag = true;
            this.closedResolve();
        }
    }
    // ── Public surface ───────────────────────────────────────────────────────
    /** The chat-level session ID. */
    sessionID() {
        return this.session.id;
    }
    /** The per-harness turns adapter. */
    getAdapter() {
        return this.adapter;
    }
    /** A coherent point-in-time view of the rendered terminal. */
    screenSnapshot() {
        return this.screen.snapshot();
    }
    /** The channel of turn-state transitions (async-iterable). */
    events() {
        return this.eventCh;
    }
    /** Block until granted the exclusive control token. FIFO. */
    acquireControl(ctx) {
        return this.queue.acquire(ctx);
    }
    /** Terminate the harness, release the writer lock, stop the watcher. */
    async close(ctx) {
        if (this.closeDone)
            return;
        this.closeDone = true;
        this.closedFlag = true;
        this.closedResolve();
        this.queue.close();
        if (this.releaseWriter)
            this.releaseWriter();
        // Reap the hook drain BEFORE stopping the harness/watcher: close() runs a
        // final flush drain (catching a Stop/idle hook that landed after the last
        // wake) and then reaps the spool dir. Managed settings.json blocks are left
        // installed (idempotent, re-ensured each session) — removal is explicit only.
        if (this.hookDrain)
            this.hookDrain.close();
        // Final liveness sample, mirroring Go's one last onAct(sess.Snapshot()) when
        // the session stops (pkg/harness/run.go). It MUST be taken BEFORE
        // this.sess.stop() below — stop tears the session state down, so a sample
        // taken afterwards would be post-mortem. Setting closedResolve() above has
        // already unblocked the activityObserver loop, so it exits without taking an
        // extra post-stop sample.
        if (this.opts.onActivity && this.sess)
            this.opts.onActivity(this.sess.snapshot());
        if (this.sess)
            await this.sess.stop(ctx);
        if (this.watcher)
            this.watcher.close();
    }
    isClosed() {
        return this.closedFlag;
    }
    // ── Send / Quit ──────────────────────────────────────────────────────────
    /** Transmit a user message; record the user turn and a pending assistant turn. */
    async send(ctx, text) {
        if (this.closedFlag)
            throw ErrClosed;
        if (!this.queue.held())
            throw ErrNoControl;
        if (this.currentTurn !== null)
            throw ErrTurnInFlight;
        await this.waitReadyForSend(ctx);
        const now = new Date();
        const userTurn = {
            id: newID(),
            sessionID: this.session.id,
            role: RoleUser,
            state: TurnStateComplete,
            text,
            reason: "",
            startedAt: now,
            completedAt: now,
            httpCode: 0,
            retryAfter: 0,
        };
        await this.store.appendTurn(userTurn);
        this.emit({ type: EventTurn, turn: userTurn });
        const assistantTurn = {
            id: newID(),
            sessionID: this.session.id,
            role: RoleAssistant,
            state: TurnStatePending,
            text: "",
            reason: "",
            startedAt: now,
            completedAt: new Date(0),
            httpCode: 0,
            retryAfter: 0,
        };
        await this.store.appendTurn(assistantTurn);
        this.currentTurn = { ...assistantTurn };
        this.endMarkerSeen = false;
        const sentScreen = this.screen.snapshot().text;
        this.sentScreenText = sentScreen;
        this.sentPromptText = text;
        this.sentTranscriptWatermark = this.captureTranscriptWatermark();
        const submitKey = submitKeyForHarness(this.opts.harness, sentScreen);
        try {
            await this.writeMessageAndSubmit(text, sentScreen, submitKey, ctx);
        }
        catch (err) {
            this.currentTurn = null;
            assistantTurn.state = TurnStateErrored;
            assistantTurn.reason = "WriteStdin: " + String(err);
            assistantTurn.completedAt = new Date();
            await this.store.updateTurn(assistantTurn);
            this.emit({ type: EventTurn, turn: assistantTurn, err });
            throw err;
        }
        this.emit({ type: EventTurn, turn: assistantTurn });
        return assistantTurn.id;
    }
    /** The underlying wrapper session, for callers reaching past the chat API. */
    wrapper() {
        return this.sess;
    }
    /** Ask the harness to exit gracefully via its adapter-defined quit sequence. */
    async quit(ctx) {
        if (this.closedFlag)
            throw ErrClosed;
        const seq = this.adapterQuitSequence();
        if (!seq || seq.length === 0)
            throw ErrQuitUnsupported;
        const release = await this.queue.acquire(ctx);
        try {
            this.writeKeys(seq);
        }
        finally {
            release();
        }
    }
    // ── Interactive input ────────────────────────────────────────────────────
    /** Respond to the interactive prompt currently awaiting an answer. */
    async answer(_ctx, requestID, ans) {
        if (this.closedFlag)
            throw ErrClosed;
        if (!this.queue.held())
            throw ErrNoControl;
        const req = this.currentInput;
        if (req === null)
            throw ErrNoInputPending;
        if (requestID !== "" && requestID !== req.id)
            throw ErrStaleInputRequest;
        await this.writeAnswer(req, ans);
    }
    /** Records a pending request and tries policy/handler resolution, else surfaces. */
    handleInputRequested(req) {
        if (!req)
            return;
        this.currentInput = req;
        this.inputSurfaced = false;
        if (this.tryAutoDismissCodex(req))
            return;
        if (this.tryResolveInput(req))
            return;
        this.inputSurfaced = true;
        this.signalInputState();
        this.emit({ type: EventInputRequest, input: toClientInputRequest(req) });
    }
    handleInputResolved(_req) {
        const had = this.currentInput;
        this.currentInput = null;
        this.inputSurfaced = false;
        this.signalInputState();
        if (had === null)
            return;
        this.emit({ type: EventInputResolved, input: toClientInputRequest(had) });
    }
    signalInputState() {
        this.inputStateCh.signal();
    }
    /** A prompt is pending that no policy/handler is resolving. */
    inputAwaitingClient() {
        return this.currentInput !== null && this.inputSurfaced;
    }
    /**
     * The interactive prompt currently awaiting a client answer, or null. The
     * polling counterpart of the EventInputRequest event: a caller that missed
     * the event (attached late, single events() consumer elsewhere) can still
     * read the pending question and resolve it via answer().
     */
    pendingInput() {
        if (!this.inputAwaitingClient())
            return null;
        return toClientInputRequest(this.currentInput);
    }
    writeKeys(p) {
        if (this.writeStdin) {
            this.writeStdin(p);
            return;
        }
        if (!this.sess)
            throw new Error("chat: no session to write to");
        this.sess.writeStdin(p);
    }
    /**
     * Delivers a user message to the harness. For prompt-readiness harnesses the
     * text and the submit key go out as TWO separate PTY writes, with a bounded
     * wait in between for the composer to echo the text: codex 0.142.5 (and
     * claude-code 2.1.201, META-HARNESS-24) consume a text+Enter burst arriving
     * in one input batch as a paste, rendering the Enter as a newline and leaving
     * the prompt unsubmitted in the composer — after which codex never writes a
     * rollout file and the turn dies as a transcript-read miss (META-HARNESS-21).
     * Other harnesses keep the single-burst write.
     *
     * NOT async on purpose: the text write throws synchronously (callers that
     * decide surfacing on a sync throw rely on that); only the echo wait and the
     * submit write are deferred into the returned promise.
     */
    writeMessageAndSubmit(text, preWriteScreen, submitKey, ctx) {
        if (!requiresPromptReadiness(this.opts.harness)) {
            this.writeKeys(concat(enc.encode(text), submitKey));
            return Promise.resolve();
        }
        this.writeKeys(enc.encode(text));
        return this.awaitComposerEcho(text, preWriteScreen, ctx).then(() => {
            this.writeKeys(submitKey);
        });
    }
    echoBoundDur() {
        const configured = this.opts.echoBound && this.opts.echoBound > 0
            ? this.opts.echoBound
            : submitEchoGap;
        // The submit key must land well inside the idle-completion window: an echo
        // wait outliving it would let the swallowed-prompt check judge (and error)
        // the turn before the submit was even written. Matters when a caller
        // shrinks idleGap (tests) without also shrinking the echo bound.
        return Math.min(configured, this.idleGapDur() / 2);
    }
    /**
     * Waits (bounded by echoBoundDur) until the composer echoes the just-written
     * message text. Primary signal: the screen contains the first line of the
     * text truncated to echoNeedleLen chars (wrap-proof at any supported width).
     * Fallback signal: past the halfway mark — or immediately when the text has
     * no matchable first line — ANY screen change since the pre-write snapshot
     * counts, covering composers that transform the echo (paste placeholders,
     * styling). On the local echo deadline or close it simply returns, degrading
     * to the old single-burst timing: the submit is written regardless, so this
     * can delay a send but never hang or drop it. The run-level ctx (when given)
     * is different: its expiry means the whole run is over, so it THROWS instead
     * of degrading — otherwise a hung harness would let the buffered errored-turn
     * event outrace the deadline classification (exit 1 instead of 124).
     */
    async awaitComposerEcho(text, preWriteScreen, ctx) {
        const needle = (text.split("\n", 1)[0] ?? "")
            .trim()
            .slice(0, echoNeedleLen);
        const bound = this.echoBoundDur();
        const deadline = sleep(bound);
        const half = sleep(bound / 2);
        const never = new Promise(() => { });
        let halfDone = false;
        const [notify, unsubscribe] = this.screen.subscribe();
        try {
            for (;;) {
                const cur = this.screen.snapshot().text;
                if (needle !== "" && cur.includes(needle))
                    return;
                if ((halfDone || needle === "") && cur !== preWriteScreen)
                    return;
                const which = await Promise.race([
                    this.closedPromise.then(() => "closed"),
                    notify
                        .receive()
                        .then((r) => (r.ok ? "changed" : "closed")),
                    (halfDone ? never : half.promise).then(() => "half"),
                    deadline.promise.then(() => "deadline"),
                    ctx
                        ? ctx.done().then(() => "ctx")
                        : never.then(() => "ctx"),
                ]);
                if (which === "ctx")
                    throw ctx?.err() ?? new Error("chat: context done");
                if (which === "closed" || which === "deadline")
                    return;
                if (which === "half")
                    halfDone = true;
            }
        }
        finally {
            deadline.cancel();
            half.cancel();
            unsubscribe();
        }
    }
    tryAutoDismissCodex(req) {
        if (this.opts.harness !== "codex" || this.opts.disableCodexAutoDismiss)
            return false;
        const [keys, ok] = codex.AutoDismissKeys(req);
        if (!ok || !keys)
            return false;
        this.writeKeys(keys);
        return true;
    }
    tryResolveInput(req) {
        const opt = this.policyOption(req);
        if (opt) {
            this.writeKeys(opt.keys);
            return true;
        }
        if (this.opts.onInputRequest) {
            const [ans, ok] = this.opts.onInputRequest(toClientInputRequest(req));
            if (ok) {
                try {
                    // writeAnswer validates and writes the first keys synchronously, so
                    // an unknown option or a dead PTY still falls through to surface.
                    // Only the echo-gated submit tail is deferred; a late submit-write
                    // failure cannot un-resolve an already-accepted answer.
                    void this.writeAnswer(req, ans).catch(() => { });
                    return true;
                }
                catch {
                    // fall through to surface
                }
            }
        }
        return false;
    }
    policyOption(req) {
        const d = resolvePolicy(this.opts.inputPolicy, req.kind);
        if (!d)
            return null;
        switch (d.kind) {
            case DispositionAnswer:
                return findOption(req, d.optionID ?? "");
            case DispositionDeny:
                return findOptionByAlias(req, "deny");
            default:
                return null;
        }
    }
    /**
     * NOT async on purpose: validation and the first keystroke write throw
     * synchronously (tryResolveInput's fall-through-to-surface relies on that);
     * only the echo-gated submit tail of the free-text branch is deferred into
     * the returned promise.
     */
    writeAnswer(req, ans) {
        const opts = req.options ?? [];
        if (opts.length === 0) {
            const preWriteScreen = this.screen.snapshot().text;
            const submit = submitKeyForHarness(this.opts.harness, preWriteScreen);
            return this.writeMessageAndSubmit(ans.text ?? "", preWriteScreen, submit);
        }
        // Multi-select prompts: toggle every named option, then commit with the
        // request's submit keys (a single optionID answer is normalized into the
        // same toggle-and-commit path — a bare toggle would never resolve the
        // prompt). Validation precedes any write so a bad id surfaces cleanly.
        const ids = ans.optionIDs && ans.optionIDs.length > 0
            ? ans.optionIDs
            : ans.optionID
                ? [ans.optionID]
                : [];
        if (req.multiSelect && req.submitKeys) {
            const chosen = ids.map((s) => findOption(req, s));
            if (ids.length === 0 || chosen.some((o) => o === null))
                throw ErrUnknownOption;
            for (const o of chosen)
                this.writeKeys(o.keys);
            this.writeKeys(req.submitKeys);
            return Promise.resolve();
        }
        if (ids.length > 1)
            throw ErrNotMultiSelect;
        const opt = findOption(req, ids[0] ?? "");
        if (!opt)
            throw ErrUnknownOption;
        this.writeKeys(opt.keys);
        return Promise.resolve();
    }
    // ── Watcher pump & turn-state machine ────────────────────────────────────
    async consumeWatcher() {
        try {
            for await (const ev of this.watcher.events()) {
                await this.handleTurnsEvent(ev);
            }
        }
        finally {
            // The event loop is done only after pump 1 processed the TERMINAL event
            // (watcher.events() returns done from pumpDone()), so this is the correct
            // post-terminal seam to snapshot the full run-level observation — not
            // watcher.close(), which never joins pump 1.
            this.finalObservation = this.watcher.observation();
            this.eventCh.close();
        }
    }
    /**
     * The run-level observation: the LARGEST retryAfter seen across every raw
     * wrapper event and whether ANY event reported an api_error mid-run (even one
     * that produced no turn transition, or that later recovered to a different
     * terminal status). Returns the empty observation until consumeWatcher's loop
     * completes. Ports Go's post-terminal Result observation (pkg/harness/run.go).
     */
    observation() {
        return this.finalObservation;
    }
    async handleTurnsEvent(ev) {
        switch (ev.kind) {
            case InputRequested:
                this.handleInputRequested(ev.input);
                return;
            case InputResolved:
                this.handleInputResolved(ev.input);
                return;
        }
        if (ev.kind === TurnComplete) {
            await this.maybeExtractSessionID();
            if (this.opts.harness === "claude-code") {
                const pending = this.currentTurn !== null;
                if (pending) {
                    this.endMarkerSeen = true;
                    this.markerArmCh.signal();
                    return;
                }
            }
        }
        const turn = this.currentTurn;
        this.currentTurn = null;
        if (turn === null)
            return;
        switch (ev.kind) {
            case TurnComplete:
                turn.state = TurnStateComplete;
                turn.completedAt = ev.at ?? new Date();
                turn.reason = ev.reason;
                if (ev.snap)
                    turn.text = this.assistantText(ev.snap);
                break;
            case Blocked:
            case Errored:
                turn.state = TurnStateErrored;
                turn.completedAt = ev.at ?? new Date();
                turn.reason = ev.reason;
                turn.httpCode = ev.httpCode ?? 0;
                turn.retryAfter = ev.retryAfter ?? 0;
                break;
            case ToolCall:
                this.currentTurn = turn;
                return;
            default:
                this.currentTurn = turn;
                return;
        }
        try {
            await this.store.updateTurn(turn);
        }
        catch (err) {
            this.emit({ type: EventTurn, turn: { ...turn }, err });
            return;
        }
        this.emit({ type: EventTurn, turn: { ...turn } });
    }
    idleGapDur() {
        return this.opts.idleGap && this.opts.idleGap > 0
            ? this.opts.idleGap
            : idleCompletionGap;
    }
    markerGapDur() {
        return this.opts.markerGap && this.opts.markerGap > 0
            ? this.opts.markerGap
            : markerConfirmGap;
    }
    async idleCompletionWatcher() {
        if (!requiresPromptReadiness(this.opts.harness))
            return;
        const [notify, unsubscribe] = this.screen.subscribe();
        try {
            let notifyP = notify.receive();
            let markerP = this.markerArmCh.receive();
            let gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur();
            let timer = sleep(gap);
            for (;;) {
                if (this.closedFlag)
                    return;
                const which = await Promise.race([
                    notifyP.then((r) => r.ok ? "notify" : "closed"),
                    markerP.then(() => "marker"),
                    this.closedPromise.then(() => "closed"),
                    timer.promise.then(() => "timer"),
                ]);
                if (which === "closed")
                    return;
                if (which === "notify")
                    notifyP = notify.receive();
                if (which === "marker")
                    markerP = this.markerArmCh.receive();
                if (which === "timer")
                    await this.maybeIdleComplete();
                // Re-arm on every event with the (possibly shortened) gap.
                timer.cancel();
                gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur();
                timer = sleep(gap);
            }
        }
        finally {
            unsubscribe();
        }
    }
    activityIntervalDur() {
        return this.opts.activityInterval && this.opts.activityInterval > 0
            ? this.opts.activityInterval
            : DefaultActivityInterval;
    }
    /**
     * The periodic liveness ticker. Ports Go's startActivityObserver /
     * ActivityInterval (pkg/harness/run.go): every activityInterval ms it samples
     * the WRAPPER-SESSION snapshot (sess.snapshot(), carrying lastOutputAt) and
     * hands it to onActivity. Its SOLE gate is the callback being set — unlike
     * idleCompletionWatcher it is deliberately harness-INDEPENDENT (no
     * requiresPromptReadiness early-return): liveness must be observable on every
     * harness. The final sample is taken by close() before sess.stop(), so this
     * loop only needs to fire on the timer and exit on close (no post-stop
     * sample). Driven by the cancellable sleep() raced against closedPromise so
     * teardown leaves no leaked timer (same discipline as the hook drain).
     */
    async activityObserver() {
        if (this.opts.onActivity === undefined)
            return;
        const interval = this.activityIntervalDur();
        for (;;) {
            if (this.closedFlag)
                return;
            const timer = sleep(interval);
            const which = await Promise.race([
                this.closedPromise.then(() => "closed"),
                timer.promise.then(() => "timer"),
            ]);
            timer.cancel();
            if (which === "closed")
                return;
            if (this.closedFlag)
                return;
            if (this.sess)
                this.opts.onActivity(this.sess.snapshot());
        }
    }
    async maybeIdleComplete() {
        const turn = this.currentTurn;
        if (turn === null)
            return;
        if (this.inputAwaitingClient())
            return;
        const marker = this.endMarkerSeen;
        const snap = this.screen.snapshot();
        if (!marker && !readyForInput(this.opts.harness, snap.text))
            return;
        if (this.adapterBusy(snap))
            return;
        const gap = marker ? this.markerGapDur() : this.idleGapDur();
        if (Date.now() - turn.startedAt.getTime() < gap)
            return;
        if (this.currentTurn === null || this.currentTurn.id !== turn.id)
            return;
        // Kill the false-success path: on the idle-completion fallback (no marker
        // observed), a screen the adapter recognizes as a swallowed prompt — a
        // settled ready screen with no assistant output for this turn — errors the
        // turn instead of completing it with the raw ready screen as the "reply".
        if (!marker && this.adapterPromptNotAccepted(snap)) {
            // The screen-only swallow verdict can false-fire when the TUI repaint
            // lags the idle gap (META-HARNESS-28), so for adapters whose verdict has
            // no extraction backing, the on-disk transcript gets a veto before the
            // turn errors. currentTurn stays HELD through the awaits below — send()
            // rejects with ErrTurnInFlight only while it is non-null, which is what
            // keeps a new turn from interleaving with the proof reads (including
            // the flush-lag retry sleep). Session-id extraction runs FIRST so an id
            // visible only on this settled swallowed screen is usable by the proof.
            await this.maybeExtractSessionID();
            const [proof, diag] = await this.transcriptProofOfCurrentTurn();
            if (this.closedFlag)
                return;
            if (this.currentTurn === null || this.currentTurn.id !== turn.id)
                return;
            this.currentTurn = null;
            this.endMarkerSeen = false;
            turn.completedAt = new Date();
            if (proof !== null) {
                turn.state = TurnStateComplete;
                turn.reason =
                    this.opts.harness +
                        ": transcript-confirmed completion (screen looked swallowed; rollout shows the submitted prompt followed by assistant output)";
                // The clean transcript reply — NOT assistantText, which for adapters
                // without extractMessage would persist the raw ready screen.
                turn.text = proof.text;
            }
            else {
                turn.state = TurnStateErrored;
                turn.reason =
                    this.opts.harness +
                        ": prompt not accepted / no assistant output" +
                        (diag !== "" ? "; " + diag : "");
            }
            try {
                await this.store.updateTurn(turn);
            }
            catch (err) {
                this.emit({ type: EventTurn, turn: { ...turn }, err });
                return;
            }
            this.emit({ type: EventTurn, turn: { ...turn } });
            return;
        }
        this.currentTurn = null;
        this.endMarkerSeen = false;
        await this.maybeExtractSessionID();
        turn.state = TurnStateComplete;
        turn.completedAt = new Date();
        turn.reason = marker
            ? this.opts.harness + ": end-of-turn marker confirmed at a settled prompt"
            : this.opts.harness +
                ": idle-completion fallback (end-of-turn marker not observed)";
        turn.text = this.assistantText(snap, /* wholeScreenFallback */ marker);
        try {
            await this.store.updateTurn(turn);
        }
        catch (err) {
            this.emit({ type: EventTurn, turn: { ...turn }, err });
            return;
        }
        this.emit({ type: EventTurn, turn: { ...turn } });
    }
    // ── Session-id capture ───────────────────────────────────────────────────
    async maybeExtractSessionID() {
        // Resume-fork refresh: the id was seeded from a resume into a harness that
        // forks (mints a new id) on `resume`, so the seeded value is provisional.
        // Locate the freshly-minted id from disk and adopt it once, then disarm. We
        // only consume the latch on a genuine change: until the forked rollout lands
        // the locator still returns the old id, and we keep retrying. This is the
        // ONLY path that overwrites an already-set harnessSessionID.
        if (this.harnessSessionIDProvisional) {
            // Provisional-refresh (forking resume): the disk-locate IS the mechanism
            // here — a forking adapter mints a fresh id onto a new rollout that only
            // disk-locate can see. Always allow it. Codex never arms this latch
            // (resumeForksSessionID() === false), so the guarded first-write path
            // below is unaffected by this branch.
            const [id, ok] = this.extractSessionID(true);
            if (ok && id !== "" && id !== this.session.harnessSessionID) {
                // Persist-before-set: on a persist failure keep the latch armed and the
                // old id so the next TurnComplete retries.
                const done = await this.captureAndPersistSessionID(id, 
                /* replace */ true);
                if (done)
                    this.harnessSessionIDProvisional = false;
            }
            return;
        }
        if (this.session.harnessSessionID !== "")
            return;
        // First-write path: allow the disk fallback ONLY when the prime wrote
        // `/status` but the box never yielded an id (`written_uncaptured`). In the
        // common case the scrape works and the fallback is never consulted, so
        // race-freedom is preserved. See extractSessionID / primeOutcome.
        const [id, ok] = this.extractSessionID(this.primeOutcome === "written_uncaptured");
        if (!ok)
            return;
        await this.captureAndPersistSessionID(id, /* replace */ false);
    }
    /**
     * Persists `id` then, only on a committed write, sets it in memory. Ordering
     * matters: the first-write-wins guards short-circuit once the in-memory id is
     * non-empty, so setting in memory before a failed persist would wedge the id
     * empty in the store forever. Persist-first means a failed updateSession leaves
     * the in-memory id unchanged, so the next TurnComplete legitimately retries.
     *
     * `replace=false` (first-write mode): a no-op once the id is already set.
     * `replace=true` (provisional-refresh mode): overwrites a non-empty seeded id
     * only when `id` genuinely differs. Returns true iff the id was persisted+set.
     * The store rejection is caught here so it can never surface as unhandled.
     */
    async captureAndPersistSessionID(id, replace) {
        if (id === "")
            return false;
        const current = this.session.harnessSessionID;
        if (replace) {
            if (id === current)
                return false;
        }
        else if (current !== "") {
            return false;
        }
        try {
            await this.store.updateSession({ ...this.session, harnessSessionID: id });
        }
        catch {
            return false; // leave in-memory unchanged; retry on the next turn
        }
        this.session.harnessSessionID = id;
        // Backfill any acquisition events emitted before the id was known (a
        // cross-line hazard): the id now exists, so retained envelopes get it
        // stamped in place. StreamTap reads the id here; it never writes the record.
        this.streamTap?.backfill();
        return true;
    }
    /** Extract the id from the current screen and first-write it. True once set. */
    async captureFromScreen() {
        if (this.session.harnessSessionID !== "")
            return true;
        // Called inside the prime poll loop: the disk fallback is premature during
        // priming (the whole point of the poll is to render and scrape the box), and
        // primeOutcome is not yet finalized. Scrape only.
        const [id, ok] = this.extractSessionID(false);
        if (!ok)
            return false;
        return this.captureAndPersistSessionID(id, /* replace */ false);
    }
    primeBoundDur() {
        return this.opts.primeBound && this.opts.primeBound > 0
            ? this.opts.primeBound
            : primeBoundGap;
    }
    /**
     * Primes the harness session id at first idle by writing the adapter's
     * primeSessionIDKeys (Codex: `/status`), which renders the id on screen, then
     * capturing it — all before Open returns the handle, so no public method can
     * race the primer (they need the handle; send/answer also need the control
     * token, which the primer holds). Bounded by an internal deadline so Open can
     * never hang; a capture miss is non-fatal (the `/quit` hint and the first
     * TurnComplete re-scrape remain backstops). Only lifecycle/IO failures — ctx
     * cancellation, ErrClosed, or a writeKeys throw — are fatal and propagate to
     * openWithSession's cleanup. Records the outcome in primeOutcome for tests.
     */
    async primeSessionID(ctx) {
        const a = this.adapter;
        if (typeof a.primeSessionIDKeys !== "function")
            return;
        if (this.session.harnessSessionID !== "")
            return;
        // The row-anchored /status scrape needs the box to render unwrapped; below
        // the documented minimum width the box wraps and the scrape can't parse it,
        // so skip the write entirely and let the /quit hint backstop.
        const cols = this.opts.cols && this.opts.cols > 0 ? this.opts.cols : 120;
        if (cols < codex.CODEX_STATUS_MIN_COLS) {
            this.primeOutcome = "too_narrow";
            return;
        }
        const release = await this.queue.acquire(ctx);
        const bound = this.primeBoundDur();
        const deadline = sleep(bound);
        const half = sleep(bound / 2);
        const never = new Promise(() => { });
        let wrote = false;
        try {
            // Step 3: wait past interstitials/auto-dismiss for a ready prompt.
            const w0 = await this.awaitPromptReadyUntil(ctx, deadline.promise);
            if (w0 === "deadline") {
                this.primeOutcome = "not_written";
                return;
            }
            // Step 4: surface the id. A writeKeys throw is fatal (writer/PTY dead).
            this.writeKeys(a.primeSessionIDKeys());
            wrote = true;
            // Step 5: check-before-wait (a render landing right after the write, before
            // any subscription delivery, is otherwise missed), then poll under one
            // subscription until captured or the deadline fires.
            const [notify, unsubscribe] = this.screen.subscribe();
            try {
                if (await this.captureFromScreen()) {
                    this.primeOutcome = "captured";
                    return;
                }
                let resent = false;
                for (;;) {
                    const which = await Promise.race([
                        ctx.done().then(() => "ctx"),
                        this.closedPromise.then(() => "closed"),
                        notify
                            .receive()
                            .then((r) => (r.ok ? "changed" : "closed")),
                        (resent ? never : half.promise).then(() => "half"),
                        deadline.promise.then(() => "deadline"),
                    ]);
                    if (which === "ctx")
                        throw ctx.err();
                    if (which === "closed")
                        throw ErrClosed;
                    if (which === "changed") {
                        if (await this.captureFromScreen()) {
                            this.primeOutcome = "captured";
                            return;
                        }
                        continue;
                    }
                    if (which === "half") {
                        // One-shot resend at the halfway mark: only when still empty and the
                        // composer prompt is ready. Consume the latch either way (at most one).
                        resent = true;
                        if (readyForInput(this.opts.harness, this.screen.snapshot().text)) {
                            this.writeKeys(a.primeSessionIDKeys());
                        }
                        continue;
                    }
                    break; // deadline
                }
                // Distinguish a persist failure (box rendered + parsed, but the store
                // rejected, so the id is still empty) from a plain poll miss. Scrape
                // ONLY (allowDiskFallback=false): this discriminator must reflect the
                // screen scrape alone. If the disk fallback ran here, a matching rollout
                // already on disk would set `parsed = true` even though the box never
                // rendered — misclassifying `written_uncaptured` as `persist_failed`,
                // which is NOT in the firing gate set, so the fallback would then never
                // arm on the next TurnComplete (silently disabling itself).
                const [, parsed] = this.extractSessionID(false);
                this.primeOutcome =
                    parsed && this.session.harnessSessionID === ""
                        ? "persist_failed"
                        : "written_uncaptured";
            }
            finally {
                unsubscribe();
            }
        }
        catch (err) {
            // Capture misses are non-fatal; lifecycle/IO failures propagate. A
            // client-facing prompt we can't auto-dismiss is a miss, not a failure.
            if (err === ErrInputPending) {
                this.primeOutcome = wrote ? "written_uncaptured" : "not_written";
                return;
            }
            throw err;
        }
        finally {
            deadline.cancel();
            half.cancel();
            release();
        }
    }
    /**
     * Screen-scrape first, then (only when allowDiskFallback) the adapter's
     * disk-locate. allowDiskFallback is a REQUIRED parameter so tsc flags any
     * caller left unconverted — the gate must be decided at every call site:
     *   - provisional-refresh (forking resume): true — locate is the mechanism.
     *   - first-write (codex): primeOutcome === "written_uncaptured" only.
     *   - captureFromScreen (during priming) and the primeSessionID discriminator:
     *     false — scrape only; the disk fallback is premature/outcome-polluting there.
     * This scopes the disk fallback to the codex first-write backstop and keeps
     * the common scrape path race-free.
     */
    extractSessionID(allowDiskFallback) {
        const a = this.adapter;
        if (typeof a.extractSessionID === "function") {
            const [id, ok] = a.extractSessionID(this.screen.snapshot());
            if (ok)
                return [id, true];
        }
        if (allowDiskFallback && typeof a.locateSessionID === "function") {
            const [id, ok] = a.locateSessionID(this.opts.workingDir ?? "");
            if (ok)
                return [id, true];
        }
        return ["", false];
    }
    async captureRawSessionID(line) {
        if (this.session.harnessSessionID !== "")
            return;
        const a = this.adapter;
        if (typeof a.extractSessionIDFromLine !== "function")
            return;
        const [id, ok] = a.extractSessionIDFromLine(line);
        if (!ok)
            return;
        // Route through the shared persist-before-set path (first-write mode) so raw
        // line capture gets the same correctness as the screen-scrape path.
        await this.captureAndPersistSessionID(id, /* replace */ false);
    }
    // ── History ──────────────────────────────────────────────────────────────
    async history() {
        const [out] = await this.historyWithSource();
        return out;
    }
    async historyWithSource() {
        const sessionCopy = { ...this.session };
        const a = this.adapter;
        const hasReader = typeof a.readTranscript === "function";
        if (!hasReader || sessionCopy.harnessSessionID === "") {
            const out = await this.store.listTurns(sessionCopy.id);
            return [out, HistorySourceStore];
        }
        let tturns;
        try {
            tturns = a.readTranscript(sessionCopy.harnessSessionID, this.opts.workingDir ?? "");
        }
        catch (err) {
            // A not-yet-flushed (or lost) transcript degrades to store history,
            // favoring availability. Real reader failures (parse/permission/etc.)
            // rethrow so they are not silently masked.
            if (isSentinel(err, ErrSessionNotFound) ||
                isSentinel(err, ErrEmptySessionID)) {
                const out = await this.store.listTurns(sessionCopy.id);
                return [out, HistorySourceStore];
            }
            throw err;
        }
        const out = tturns.map((tt) => ({
            id: "",
            sessionID: sessionCopy.id,
            role: tt.role,
            state: TurnStateComplete,
            text: tt.text,
            reason: "",
            startedAt: tt.timestamp ?? new Date(0),
            completedAt: tt.timestamp ?? new Date(0),
            httpCode: 0,
            retryAfter: 0,
        }));
        return [out, HistorySourceTranscript];
    }
    // ── Helpers ──────────────────────────────────────────────────────────────
    /**
     * `wholeScreenFallback=false` (the idle-completion, non-marker path) forbids
     * the raw-screen fallback for adapters that CAN extract a message: when their
     * extraction fails there, a ready screen must never be persisted as the
     * reply. Adapters without extractMessage keep the raw-screen fallback — it is
     * their only reply-capture mechanism.
     */
    assistantText(snap, wholeScreenFallback = true) {
        const a = this.adapter;
        if (typeof a.extractMessage === "function") {
            const [msg, ok] = a.extractMessage(snap);
            if (ok)
                return msg;
            if (!wholeScreenFallback)
                return "";
        }
        return snap.text;
    }
    adapterPromptNotAccepted(snap) {
        const a = this.adapter;
        if (typeof a.promptNotAccepted === "function") {
            return a.promptNotAccepted(snap, this.sentScreenText);
        }
        return false;
    }
    /**
     * The transcript-backed swallow override applies only to adapters that CAN
     * read their on-disk transcript but CANNOT extract a reply from the screen —
     * today exactly Codex. With extractMessage present the swallow verdict is
     * already extraction-backed (Claude Code), and the transcript must not
     * second-guess it. Structural probes, same pattern as assistantText().
     */
    transcriptOverrideEligible() {
        // Runs on EVERY send (unlike the other structural probes, which only run
        // once a watcher is pumping), so it must tolerate adapter-less test
        // Conversations constructed directly from ConversationInit.
        const a = this.adapter;
        return (a !== undefined &&
            typeof a.readTranscript === "function" &&
            typeof a.extractMessage !== "function");
    }
    readTranscriptTurns(id) {
        const a = this.adapter;
        return a.readTranscript(id, this.opts.workingDir ?? "");
    }
    /**
     * The transcript turn count immediately before the in-flight submit — the
     * pre-send watermark for transcriptProofOfCurrentTurn. readTranscript is
     * synchronous, so send() pays no new await. Rules: not eligible → null (the
     * proof gate declines before looking); empty harnessSessionID → 0 (fresh
     * session, no prior history); a sentinel read failure (no rollout yet) → 0;
     * any other failure → null ("unknown" — the proof helper then declines
     * rather than guessing a lower bound). Never throws out of send().
     */
    captureTranscriptWatermark() {
        if (!this.transcriptOverrideEligible())
            return null;
        if (this.session.harnessSessionID === "")
            return 0;
        try {
            return this.readTranscriptTurns(this.session.harnessSessionID).length;
        }
        catch (err) {
            if (isSentinel(err, ErrSessionNotFound) ||
                isSentinel(err, ErrEmptySessionID))
                return 0;
            return null;
        }
    }
    /**
     * transcriptProofOfCurrentTurn consults the adapter's on-disk transcript for
     * positive proof that the in-flight prompt was accepted and answered, to
     * veto a screen-derived swallowed-prompt verdict on the idle fallback path
     * (META-HARNESS-28: under load the codex TUI repaint lags the idle gap, so
     * the screen-only detector false-fires on fully successful turns whose
     * rollout is already on disk).
     *
     * Returns [proof, diagnostic]. Proof requires the FIRST RoleUser transcript
     * turn at index ≥ the pre-send watermark whose text equals the sent prompt —
     * both sides through stripIDEContextTags, because codex parsing already
     * strips those tags from user text — followed by ≥1 non-empty RoleAssistant
     * turn before the next RoleUser turn (RoleSystem turns in between are
     * skipped; later turns can never contaminate the reply). Matching is
     * deliberately scoped to single-text-block user messages — codex 0.142.5's
     * TUI shape; appendMessageEvents emits one transcript turn per content
     * block, so a split prompt degrades to no-proof, the conservative direction.
     *
     * Error semantics (nothing thrown may escape maybeIdleComplete): sentinel
     * reader errors yield no proof silently; any other reader error yields no
     * proof plus a diagnostic. A transcript problem never flips errored →
     * completed; only positive proof does. A first read that misses in a
     * flush-lag shape (ErrSessionNotFound, or no prompt match at/after the
     * watermark) retries ONCE after transcriptFlushRetryGap, with the turn
     * still held by the caller. A null watermark never retries.
     */
    async transcriptProofOfCurrentTurn() {
        if (!this.transcriptOverrideEligible())
            return [null, ""];
        if (this.session.harnessSessionID === "")
            return [null, ""];
        const watermark = this.sentTranscriptWatermark;
        if (watermark === null)
            return [null, "pre-send transcript watermark unavailable"];
        const first = this.tryTranscriptProof(watermark);
        if (first.proof !== null || !first.retryable)
            return [first.proof, first.diag];
        const timer = sleep(transcriptFlushRetryGap);
        try {
            await Promise.race([timer.promise, this.closedPromise]);
        }
        finally {
            timer.cancel();
        }
        if (this.closedFlag)
            return [null, first.diag];
        const second = this.tryTranscriptProof(watermark);
        return [second.proof, second.diag];
    }
    /** One synchronous proof attempt; retryable marks flush-lag-shaped misses. */
    tryTranscriptProof(watermark) {
        let turns;
        try {
            turns = this.readTranscriptTurns(this.session.harnessSessionID);
        }
        catch (err) {
            // No rollout on disk yet is the flush-lag shape worth one retry; an
            // empty-id sentinel is a plain no, and anything else is a real reader
            // failure surfaced as a diagnostic, never as success.
            if (isSentinel(err, ErrSessionNotFound))
                return { proof: null, diag: "", retryable: true };
            if (isSentinel(err, ErrEmptySessionID))
                return { proof: null, diag: "", retryable: false };
            return {
                proof: null,
                diag: "transcript check failed: " + String(err),
                retryable: false,
            };
        }
        const want = stripIDEContextTags(this.sentPromptText);
        let match = -1;
        for (let i = Math.max(0, watermark); i < turns.length; i++) {
            const t = turns[i];
            if (t.role !== RoleUser)
                continue;
            if (stripIDEContextTags(t.text) === want) {
                match = i;
                break;
            }
        }
        if (match < 0)
            return { proof: null, diag: "", retryable: true };
        const replies = [];
        for (let i = match + 1; i < turns.length; i++) {
            const t = turns[i];
            if (t.role === RoleUser)
                break; // stop: a later turn must not contaminate
            if (t.role !== RoleAssistant)
                continue; // skip RoleSystem between the two
            if (t.text.trim() === "")
                continue;
            replies.push(t.text);
        }
        if (replies.length === 0)
            return { proof: null, diag: "", retryable: false };
        return {
            proof: { text: replies.join("\n\n") },
            diag: "",
            retryable: false,
        };
    }
    adapterBusy(snap) {
        const a = this.adapter;
        if (typeof a.busy === "function") {
            return a.busy(snap);
        }
        return false;
    }
    adapterQuitSequence() {
        const a = this.adapter;
        if (typeof a.quitSequence === "function") {
            return a.quitSequence();
        }
        return null;
    }
    adapterRawSessionID() {
        const a = this.adapter;
        return typeof a.extractSessionIDFromLine === "function";
    }
    async waitReadyForSend(ctx) {
        if (this.inputAwaitingClient())
            throw ErrInputPending;
        if (!requiresPromptReadiness(this.opts.harness))
            return;
        return this.awaitPromptReady(ctx);
    }
    /**
     * Blocks until the composer prompt is ready for a message. Owns its screen
     * subscription in a try/finally so it always unsubscribes. Throws ctx.err() on
     * cancellation, ErrClosed on close, ErrInputPending on a client-facing prompt.
     * Extracted verbatim from waitReadyForSend's loop.
     */
    async awaitPromptReady(ctx) {
        const [notify, unsubscribe] = this.screen.subscribe();
        try {
            if (readyForInput(this.opts.harness, this.screen.snapshot().text))
                return;
            for (;;) {
                const which = await Promise.race([
                    ctx.done().then(() => "ctx"),
                    this.closedPromise.then(() => "closed"),
                    this.inputStateCh.receive().then(() => "input"),
                    notify
                        .receive()
                        .then((r) => r.ok ? "notify" : "notifyClosed"),
                ]);
                if (which === "ctx")
                    throw ctx.err();
                if (which === "closed")
                    throw ErrClosed;
                if (which === "notifyClosed")
                    throw ErrClosed;
                if (this.inputAwaitingClient())
                    throw ErrInputPending;
                if (readyForInput(this.opts.harness, this.screen.snapshot().text))
                    return;
            }
        }
        finally {
            unsubscribe();
        }
    }
    /**
     * Same readiness loop as awaitPromptReady but with an extra, NON-throwing exit:
     * when deadlinePromise resolves before the prompt is ready it returns the
     * "deadline" sentinel instead of throwing. The screen subscription is owned in
     * one try/finally so it never leaks on the timeout path (unlike racing a live
     * awaitPromptReady against a timer, which would abandon a subscribed waiter).
     * ctx cancellation still throws ctx.err(); close still throws ErrClosed;
     * a client-facing prompt still throws ErrInputPending.
     */
    async awaitPromptReadyUntil(ctx, deadlinePromise) {
        const [notify, unsubscribe] = this.screen.subscribe();
        try {
            if (readyForInput(this.opts.harness, this.screen.snapshot().text))
                return "ready";
            for (;;) {
                const which = await Promise.race([
                    ctx.done().then(() => "ctx"),
                    this.closedPromise.then(() => "closed"),
                    this.inputStateCh.receive().then(() => "input"),
                    notify
                        .receive()
                        .then((r) => r.ok ? "notify" : "notifyClosed"),
                    deadlinePromise.then(() => "deadline"),
                ]);
                if (which === "ctx")
                    throw ctx.err();
                if (which === "closed")
                    throw ErrClosed;
                if (which === "notifyClosed")
                    throw ErrClosed;
                if (which === "deadline")
                    return "deadline";
                if (this.inputAwaitingClient())
                    throw ErrInputPending;
                if (readyForInput(this.opts.harness, this.screen.snapshot().text))
                    return "ready";
            }
        }
        finally {
            unsubscribe();
        }
    }
    emit(ev) {
        this.eventCh.emit(ev);
    }
    /** Internal: start the watcher + idle pumps. Used by Open. */
    startPumps() {
        void this.consumeWatcher();
        void this.idleCompletionWatcher();
        // Harness-independent periodic liveness ticker. Runs its OWN loop (a
        // cancellable sleep raced against close), inert unless onActivity is set.
        void this.activityObserver();
        // The hook drain runs its OWN loop (spool watch + bounded fallback timer),
        // deliberately NOT hung off consumeWatcher — so a SessionStart-before-any-
        // file-change or an idle-period Stop drains promptly regardless of turn
        // activity. Inert unless the run opted in and the adapter supports hooks.
        if (this.hookDrain)
            this.hookDrain.start();
    }
}
function sleep(ms) {
    let timeout;
    const promise = new Promise((resolve) => {
        timeout = setTimeout(resolve, ms);
    });
    return {
        promise,
        cancel: () => {
            clearTimeout(timeout);
        },
    };
}
function resolvePolicy(p, kind) {
    if (!p)
        return null;
    const d = p.byKind?.[kind];
    if (d?.kind)
        return d;
    if (p.default)
        return { kind: p.default };
    return null;
}
function toClientInputRequest(req) {
    const out = { id: req.id, kind: req.kind, prompt: req.prompt };
    if (req.options && req.options.length > 0) {
        out.options = req.options.map((o) => ({
            id: o.id,
            alias: o.alias,
            label: o.label,
            ...(o.description !== undefined ? { description: o.description } : {}),
        }));
    }
    if (req.header !== undefined)
        out.header = req.header;
    if (req.multiSelect)
        out.multiSelect = true;
    return out;
}
function findOption(req, s) {
    if (s === "")
        return null;
    const ls = s.toLowerCase();
    for (const o of req.options ?? []) {
        if (o.id === s ||
            o.alias.toLowerCase() === ls ||
            o.label.toLowerCase() === ls)
            return o;
    }
    return null;
}
function findOptionByAlias(req, alias) {
    for (const o of req.options ?? []) {
        if (o.alias === alias)
            return o;
    }
    return null;
}
/** resolveAdapter maps a harness name to a concrete turns.Adapter. */
export function resolveAdapter(name) {
    switch (name) {
        case "codex":
            return codex.New();
        case "claude-code":
            return claudecode.New();
        case "opencode":
            return opencode.New();
        case "pi":
            return pi.New();
        case "generic":
        case "":
            return generic.New();
        default:
            throw wrap(`chat: unknown harness: ${name}`, ErrUnknownHarness);
    }
}
/** Open starts a harness, wires the screen + turn watcher, returns a Conversation. */
export async function Open(ctx, opts) {
    if (!opts.harness || !opts.binaryPath) {
        throw wrapInvalid("Harness and BinaryPath are required");
    }
    if (!opts.store) {
        throw wrapInvalid("Store is required (pass newMemStore() for the default)");
    }
    const session = {
        id: newID(),
        harness: opts.harness,
        workingDir: opts.workingDir ?? "",
        createdAt: new Date(),
        // When resuming, seed with the harness session id so history/session-id
        // capture reflect the resumed session immediately rather than starting empty.
        harnessSessionID: opts.resume ?? "",
    };
    return openWithSession(ctx, opts, session, /* persist */ true);
}
/**
 * openWithSession is the shared launch/wiring body behind Open and Reopen. It
 * attaches the supplied chat Session (Open mints a fresh one; Reopen reuses the
 * stored record) and, when `persist` is set, inserts it via store.createSession.
 * Reopen skips persistence because the record already exists.
 */
async function openWithSession(ctx, opts, session, persist) {
    const cols = opts.cols && opts.cols > 0 ? opts.cols : 120;
    const rows = opts.rows && opts.rows > 0 ? opts.rows : 40;
    // The advanced/testing seam wins: a caller-supplied adapter drives Open
    // directly (used to exercise Stream mode with a fake interleaved adapter).
    const adapter = opts.adapter ?? resolveAdapter(opts.harness);
    // Resolve resume args up front so an unsupported harness fails before launch.
    let resumeArgs = [];
    if (opts.resume) {
        const ra = adapterResumeArgs(adapter, opts.resume);
        if (ra === null) {
            throw wrap(`chat: harness ${opts.harness} cannot resume`, ErrResumeUnsupported);
        }
        resumeArgs = ra;
    }
    // On the create path (NOT resuming), let the adapter mint its own session id
    // and the launch args that pin it, seeding harnessSessionID before persistence.
    let initArgs = [];
    if (!opts.resume) {
        const init = adapterInitSession(adapter);
        if (init) {
            initArgs = init[0];
            session.harnessSessionID = init[1];
        }
    }
    // Whenever chat injects a session prefix (init OR resume), the caller must not
    // also pass raw session-control flags in opts.args — they would diverge the
    // real transcript from the persisted harnessSessionID. Reject before launch.
    const prefix = resumeArgs.length > 0 ? resumeArgs : initArgs;
    if (prefix.length > 0) {
        const banned = adapterSessionControlFlags(adapter);
        const bad = firstSessionControlConflict(opts.args ?? [], banned);
        if (bad) {
            throw wrapInvalid(`argument ${bad} conflicts with chat-managed session control; use Options.resume / Reopen`);
        }
    }
    const scr = newScreen(cols, rows);
    const c = new Conversation({
        opts: { ...opts, cols, rows },
        store: opts.store,
        adapter,
        screen: scr,
        session,
    });
    // Arm the one-shot resume-fork latch only when we seeded from a resume id AND
    // the adapter reports that `resume` forks (mints a new id). Non-forking
    // harnesses leave it disarmed, preserving strict first-write-wins.
    if (opts.resume && adapterResumeForks(adapter)) {
        c.harnessSessionIDProvisional = true;
    }
    // ── Hook drain (spool → canonical-Event) ─────────────────────────────────────
    // Opt-in (onHookEvents set) AND the adapter must implement HookProviderCapability
    // (structural probe, Go-optional-interface style). When active, the drain owns a
    // per-run spool dir keyed on the tracked harnessSessionID (seeded above by
    // initSession for claude-code), installs the managed settings.json block, and
    // wires HW_EVENT_SPOOL into the launch env below so out-of-process hook fires
    // land where the drain reads. Inert otherwise — existing runs are unchanged.
    if (opts.onHookEvents) {
        const provider = adapterHookProvider(adapter);
        if (provider) {
            const drain = new HookDrain({
                provider,
                workingDir: opts.workingDir ?? "",
                harnessSessionID: session.harnessSessionID,
                configDir: opts.hooksConfigDir,
                wake: c.hookDrainCh,
                closed: c["closedPromise"],
                isClosed: () => c.isClosed(),
                onEvents: opts.onHookEvents,
                onBoundaryTurns: opts.onHookBoundaryTurns,
                fallbackMs: opts.hookDrainFallbackMs,
            });
            // Create the spool dir + install the managed hook block before launch.
            drain.ensureConfig();
            c.hookDrain = drain;
        }
    }
    const runCtx = ctx
        ? { done: () => ctx.done(), err: () => ctx.err() }
        : undefined;
    // ── Acquisition plan (StreamTap) ───────────────────────────────────────────
    // Resolve the LATCHED acquisition mode for the run, then build StreamTap as an
    // ADDITIONAL consumer of the SAME durable onLine tap chat uses for raw
    // session-id capture — no second launch, no second PTY reader. The rendered
    // Screen + turn watcher (below) stay the sole turn-state authority.
    const haveSink = typeof opts.onAcquisitionEvent === "function";
    const profile = resolveProfile({
        info: {
            harness: opts.harness,
            // chat only reaches here as it launches the binary, so it is installed.
            installed: true,
            detectedVersion: "",
            pinnedVersion: "",
        },
        adapter,
        streamVersionPredicate: opts.streamVersionPredicate,
    });
    const acquisitionMode = planAcquisition(opts.acquisitionMode ?? AcquisitionModeOff, {
        profile,
        haveSink,
        // Hooks side-channel delivery is a later subtask; not viable in A1, so the
        // Hooks rung falls back to Stream (when eligible) or Off.
        hooksViable: false,
    });
    const streamParser = adapterStreamParser(adapter);
    const displaySink = opts.onDisplayLine
        ? newDisplaySink(opts.onDisplayLine)
        : null;
    const streamTap = new StreamTap({
        harness: opts.harness,
        runID: session.id,
        mode: acquisitionMode,
        parser: streamParser,
        onEvent: opts.onAcquisitionEvent,
        display: displaySink,
        // StreamTap READS the chat-captured id (never writes the session record).
        sessionID: () => c.session.harnessSessionID,
    });
    c.streamTap = streamTap;
    // Compute the child env ONCE, before binding, so the exact array handed to the
    // wrapper is the one the adapter parses its session dir from — binding against
    // a different env than the child receives is thus impossible.
    const env = cleanHarnessEnv(opts.env);
    adapter.bindLaunchEnv?.(env, opts.workingDir ?? "");
    // Wire the HW_* hook env (spool dir, cwd, home, yield file) into the launch env
    // for Hooks mode, whenever a caller supplied a YieldControl handle, or when the
    // hook drain is active. The active drain's own spool dir wins so out-of-process
    // hook fires land where the drain reads (its ensureConfig already created it);
    // otherwise fall back to the raw opts.spoolDir (Hooks-mode/yield callers).
    const hookSpoolDir = c.hookDrain
        ? c.hookDrain.spoolDir()
        : (opts.spoolDir ?? "");
    const needHookEnv = !!opts.yieldControl ||
        acquisitionMode === AcquisitionModeHooks ||
        !!c.hookDrain;
    let launchEnv = needHookEnv
        ? hookEnv(env, hookSpoolDir, opts.workingDir ?? "", opts.yieldControl ?? null)
        : env;
    // The out-of-process hook CLI keys its session-mismatch guard and config dir off
    // these; set them so a stray hook from an unrelated session is dropped and the
    // CLI resolves the same config dir the drain installed the managed block under.
    if (c.hookDrain) {
        launchEnv = [
            ...launchEnv,
            `${EnvConfigDir}=${c.hookDrain.hookContext().configDir}`,
            `${EnvSessionID}=${session.harnessSessionID}`,
        ];
    }
    // Widen the tap-instantiation gate (critique (a)): the durable LineSplitter tap
    // is created whenever EITHER consumer needs it — raw session-id capture OR the
    // StreamTap (a StreamParser under a sink, or a display sink). This lets the tap
    // exist for adapters that implement StreamParser but NOT extractSessionIDFromLine
    // (codex/opencode/pi), where the old adapterRawSessionID()-only gate was a no-op.
    const rawCapture = c["adapterRawSessionID"]();
    const needsTap = rawCapture || streamTap.installs();
    const cfg = {
        binaryPath: opts.binaryPath,
        args: prefix.length > 0 ? [...prefix, ...(opts.args ?? [])] : opts.args,
        workingDir: opts.workingDir,
        // Strip Claude Code's nesting markers (CLAUDECODE / CLAUDE_CODE_*) so a
        // nested `claude` persists its JSONL transcript. When opts.env is undefined
        // this materializes the parent env, since a PTY child would otherwise
        // inherit the markers. Mirrors run.go's cleanedEnv().
        env: launchEnv,
        stdout: scr,
        harness: opts.harness,
        effort: opts.effort,
        model: opts.model,
        // The SINGLE durable onLine callback fans out to BOTH consumers. StreamTap
        // runs synchronously (emitting live events with the current — possibly empty
        // — session id); raw capture is async (it persists the record), so an early
        // stream event ships with an empty id and is BACKFILLED once capture lands.
        onLine: needsTap
            ? (line) => {
                streamTap.onLine(line);
                if (rawCapture) {
                    void c
                        .captureRawSessionID(line)
                        .then(() => {
                        streamTap.backfill();
                    })
                        .catch(() => { });
                }
            }
            : undefined,
    };
    const sess = await wrapperStart(runCtx, cfg);
    c.sess = sess;
    const { release, ok } = sess.acquireWriter();
    if (!ok) {
        await sess.stop();
        throw new Error("chat: failed to acquire wrapper writer lock");
    }
    c.releaseWriter = release;
    sess.resize(cols, rows);
    if (persist)
        await opts.store.createSession({ ...c.session });
    c.watcher = Watch(sess, scr, adapter);
    c.startPumps();
    // Prime the harness session id before returning the handle (Codex /status
    // scrape). Suppressed on resume (the id is already seeded). A capture miss is
    // non-fatal; a fatal lifecycle/IO failure tears the half-built session down.
    if (!opts.resume) {
        try {
            await c["primeSessionID"](ctx ?? Context.background());
        }
        catch (err) {
            // ctx-less close awaits actual termination (Session.stop with the cancelled
            // Open ctx would return before the process exits and leak it).
            await c.close();
            throw err;
        }
    }
    return c;
}
/**
 * Reopen loads a stored chat Session by id and relaunches its harness in resume
 * mode, reusing the SAME chat session id rather than minting a new one — so the
 * returned Conversation's sessionID() and history reflect the resumed session.
 *
 * It derives `harness` and `workingDir` from the stored record and `resume` from
 * the stored harnessSessionID. The stored Session persists only those three
 * fields, so binaryPath, env, and all other launch knobs must be supplied by the
 * caller via ReopenOptions.
 *
 * Throws ErrNoHarnessSession when the stored session never captured a harness
 * session id, and surfaces ErrResumeUnsupported unchanged when the derived
 * harness has no SessionResumer.
 */
export async function Reopen(ctx, opts) {
    if (!opts.store) {
        throw wrapInvalid("Store is required (pass newMemStore() for the default)");
    }
    const stored = await opts.store.getSession(opts.sessionID);
    if (stored.harnessSessionID === "") {
        throw wrap(`chat: session ${opts.sessionID} has no harness session id`, ErrNoHarnessSession);
    }
    const launch = {
        ...opts,
        harness: stored.harness,
        workingDir: stored.workingDir,
        resume: stored.harnessSessionID,
    };
    return openWithSession(ctx, launch, { ...stored }, /* persist */ false);
}
/**
 * Structurally probes an adapter for the optional HookProviderCapability (the
 * same Go-optional-interface style as readTranscript / SessionIDExtractor).
 * Returns the HookProvider when present (Claude Code), else null.
 */
function adapterHookProvider(adapter) {
    const a = adapter;
    if (typeof a.hookProvider !== "function")
        return null;
    return a.hookProvider();
}
/** Structurally probes an adapter for SessionResumer; null when unsupported. */
function adapterResumeArgs(adapter, harnessSessionID) {
    const a = adapter;
    if (typeof a.resumeArgs !== "function")
        return null;
    return a.resumeArgs(harnessSessionID);
}
/** Structurally probes an adapter for SessionInitializer; null when unsupported. */
function adapterInitSession(adapter) {
    const a = adapter;
    if (typeof a.initSession !== "function")
        return null;
    return a.initSession();
}
/** Structurally probes an adapter for SessionControlFlags; [] when unsupported. */
function adapterSessionControlFlags(adapter) {
    const a = adapter;
    if (typeof a.sessionControlFlags !== "function")
        return [];
    return a.sessionControlFlags();
}
/**
 * firstSessionControlConflict scans args (up to a bare "--" terminator) for the
 * first token that conflicts with a chat-managed session-control flag: an exact
 * match, or, for a long flag, the attached `--flag=value` form. Returns the
 * offending token or undefined.
 */
function firstSessionControlConflict(args, banned) {
    const set = new Set(banned);
    const longFlags = banned.filter((f) => f.startsWith("--"));
    for (const tok of args) {
        if (tok === "--")
            break; // positionals follow; never flags
        if (set.has(tok))
            return tok;
        for (const f of longFlags) {
            if (tok.startsWith(f + "="))
                return tok;
        }
    }
    return undefined;
}
/**
 * Structurally probes an adapter for the optional SessionForkResumer capability.
 * Returns true only when the adapter explicitly reports that `resume` forks the
 * harness session id (mints a new one). Adapters that omit the method — Claude
 * Code, and Codex per the verified finding — default to no-fork.
 */
export function adapterResumeForks(adapter) {
    const a = adapter;
    if (typeof a.resumeForksSessionID !== "function")
        return false;
    return a.resumeForksSessionID();
}
function wrapInvalid(msg) {
    return wrap(`chat: invalid options: ${msg}`, ErrInvalidOptions);
}
export { EventBus, Signal };
//# sourceMappingURL=conversation.js.map