import { type Screen, type Snapshot } from "../screen/index.ts";
import { type Adapter, type Event as TurnEvent, type InputRequest as TurnsInputRequest, type Watcher } from "../turns/index.ts";
import { type Session as WrapperSession, type Snapshot as SessionSnapshot } from "../wrapper/index.ts";
import { Context } from "../internal/async/index.ts";
import type { Store } from "./store.ts";
import { type Session, type Turn, type ConversationEvent, type InputRequest, type InputAnswer, type InputPolicy, type HistorySource } from "./types.ts";
import { ControlQueue } from "./control.ts";
import type { AcquisitionMode } from "../turns/index.ts";
import type { EventEnvelope } from "../transcript/index.ts";
import { StreamTap } from "../acquisition/internal/streamTap.ts";
import { type YieldControl } from "../acquisition/internal/yield.ts";
import { type StreamVersionPredicate } from "../acquisition/internal/planAcquisition.ts";
import { HookDrain } from "./hookDrain.ts";
import type { ParsedEvent, Turn as TranscriptTurn } from "../transcript/event.ts";
/** Options configures a single Conversation. Mirrors chat.Options. */
export interface Options {
    /** Per-harness adapter name. Required. */
    harness: string;
    /** The harness executable. Required. */
    binaryPath: string;
    args?: string[];
    /**
     * When set, resumes the named *harness* session id (not the chat session id):
     * the resolved adapter must implement SessionResumer, whose resumeArgs are
     * prepended to `args` at launch, and the new chat Session's harnessSessionID
     * is seeded with this value. Open throws ErrResumeUnsupported if the harness
     * cannot resume. Prefer Reopen to derive this from a stored Session.
     */
    resume?: string;
    workingDir?: string;
    env?: string[];
    effort?: string;
    model?: string;
    cols?: number;
    rows?: number;
    /** Backs the chat metadata. Required; pass newMemStore() for the default. */
    store: Store;
    /** Sizes the events buffer. Defaults to 32. */
    eventBuffer?: number;
    /** Pre-configures how blocking interactive prompts are resolved. */
    inputPolicy?: InputPolicy;
    /** Turns off the built-in auto-dismissal of Codex startup interstitials. */
    disableCodexAutoDismiss?: boolean;
    /** In-process resolver consulted when InputPolicy did not auto-answer. */
    onInputRequest?: (req: InputRequest) => [InputAnswer, boolean];
    /** Test-only idle-completion window override (ms). Zero = package default. */
    idleGap?: number;
    /** Test-only marker-confirm window override (ms). Zero = package default. */
    markerGap?: number;
    /** Test-only session-id prime deadline override (ms). Zero = package default. */
    primeBound?: number;
    /** Test-only echo-gated submit deadline override (ms). Zero = package default. */
    echoBound?: number;
    /**
     * Periodic liveness callback. When set, activityObserver samples
     * sess.snapshot() every activityInterval ms and delivers it here, plus a final
     * sample at close() before the session stops. Absent ⇒ the observer never runs.
     */
    onActivity?: (snap: SessionSnapshot) => void;
    /**
     * The activity-observer tick period (ms). Undefined or <= 0 ⇒
     * DefaultActivityInterval (10s), mirroring Go's DefaultActivityInterval.
     */
    activityInterval?: number;
    /**
     * The REQUESTED acquisition mode. planAcquisition resolves it against the
     * resolved adapter's capabilities to the LATCHED mode actually used. Absent ⇒
     * Off (no live acquisition; the tap is created only if raw session-id capture
     * needs it, exactly as before).
     */
    acquisitionMode?: AcquisitionMode;
    /**
     * The acquisition event bridge. Admitted, stamped EventEnvelopes are delivered
     * here as the run streams. Its presence is the acquisition sink (Go's
     * `haveSink`): with no sink the plan degrades to Off.
     */
    onAcquisitionEvent?: (env: EventEnvelope) => void;
    /** Best-effort per-line display callback (bounded, may drop under back-pressure). */
    onDisplayLine?: (line: string) => void;
    /**
     * Caller-supplied cooperative-preemption handle. When present its yield-file
     * path is wired into the harness launch env (hookEnv) so a hook-capable harness
     * can be preempted mid-turn.
     */
    yieldControl?: YieldControl;
    /** Hook spool dir wired into the launch env (HW_EVENT_SPOOL) for Hooks mode. */
    spoolDir?: string;
    /**
     * The durable-store/dedup sink for drained hook events. Its presence is what
     * activates the hook drain (the analogue of onAcquisitionEvent for hooks). It
     * receives freshly-deduped SourceHook ParsedEvents — provenance observable
     * here (the durable-store layer), NEVER on an events() ConversationEvent.
     */
    onHookEvents?: (events: ParsedEvent[]) => void;
    /**
     * Optional SEPARATE chat-surface projection of turn-boundary lifecycle edges,
     * as Turns via turnsFromEvents (which carry no `source`, by construction).
     */
    onHookBoundaryTurns?: (turns: TranscriptTurn[]) => void;
    /**
     * Overrides the harness config/state dir the spool dir is derived from
     * (HookContext.configDir). Absent ⇒ the provider default (~/.claude). Mainly a
     * test seam so the managed settings.json + spool dir land under a temp dir.
     */
    hooksConfigDir?: string;
    /** Test-only bounded fallback-timer override (ms) for the hook drain loop. */
    hookDrainFallbackMs?: number;
    /**
     * Advanced/testing seam: use this already-resolved turns.Adapter instead of
     * resolving one from `harness`. Lets a test drive Open with a fake adapter that
     * implements StreamParser + interleaves stream-json (the only live exercise of
     * Stream mode in A1). Absent ⇒ resolveAdapter(harness), the normal path.
     */
    adapter?: Adapter;
    /**
     * Advanced/testing seam: overrides planAcquisition's fact-3 version predicate
     * (does THIS installed binary support stream-json). Absent ⇒ the versions.json
     * default. Injected so a test can make a fake harness Stream-eligible.
     */
    streamVersionPredicate?: StreamVersionPredicate;
}
export declare const DefaultActivityInterval = 10000;
/** A size-1 coalesced wake signal — the Go `chan struct{}` of capacity 1. */
declare class Signal {
    private pending;
    private waiter;
    signal(): void;
    receive(): Promise<void>;
    /** Non-blocking drain — true if a signal was pending (the select default). */
    tryReceive(): boolean;
}
/** A buffered chat-event channel: emit drops when full; receive/tryReceive read. */
declare class EventBus {
    private readonly cap;
    private readonly buf;
    private readonly recvWaiters;
    private _closed;
    constructor(cap: number);
    /** Non-blocking push; drops the event when the buffer is full (Go's emit). */
    emit(ev: ConversationEvent): void;
    /** Synchronous, non-blocking receive — the Go `select { case <-ch: default }`. */
    tryReceive(): {
        value?: ConversationEvent;
        ok: boolean;
    };
    receive(): Promise<{
        value?: ConversationEvent;
        ok: boolean;
    }>;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<ConversationEvent>;
}
/** Fields a Conversation can be constructed with (the Go struct-literal shape). */
export interface ConversationInit {
    opts?: Partial<Options>;
    store?: Store;
    adapter?: Adapter;
    sess?: WrapperSession;
    screen?: Screen;
    watcher?: Watcher;
    queue?: ControlQueue;
    session?: Session;
    eventCh?: EventBus;
    currentTurn?: Turn | null;
    markerArmCh?: Signal;
    inputStateCh?: Signal;
    hookDrainCh?: Signal;
    closed?: boolean;
    /** Test injection: replaces sess.writeStdin for answer/quit keystrokes. */
    writeStdin?: (p: Uint8Array) => void;
}
export declare class Conversation {
    opts: Options;
    store: Store;
    adapter: Adapter;
    sess?: WrapperSession;
    screen: Screen;
    watcher?: Watcher;
    releaseWriter?: () => void;
    queue: ControlQueue;
    session: Session;
    /**
     * The final run-level observation, captured off the watcher AFTER
     * consumeWatcher's event loop drains the terminal event (the post-terminal
     * seam — watcher.close() is NOT a valid barrier; it only joins the screen
     * pump). Rolls up the LARGEST retryAfter and whether ANY raw wrapper event
     * reported an api_error, EVEN one that produced no turn transition. Defaults
     * to the empty observation until the loop completes. Ports Go's Result
     * observation (pkg/harness/run.go).
     */
    private finalObservation;
    /**
     * The per-run acquisition tap: a PARALLEL CONSUMER of the same durable PTY line
     * tap `captureRawSessionID` reads from. Set by openWithSession when the plan or
     * a display sink needs it; otherwise undefined. Never drives turn state.
     */
    streamTap?: StreamTap;
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
    harnessSessionIDProvisional: boolean;
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
    private primeOutcome?;
    eventCh: EventBus;
    currentTurn: Turn | null;
    endMarkerSeen: boolean;
    /** Rendered screen at the moment send() submitted the in-flight prompt. */
    private sentScreenText;
    /** Raw prompt text of the in-flight send (transcript swallow-override proof). */
    private sentPromptText;
    /**
     * Transcript turn count captured just before the in-flight submit, or null
     * when unknown. The swallow-override proof only accepts a prompt match at an
     * index ≥ this watermark, so an identical prompt earlier in a resumed rollout
     * can never count as proof of the CURRENT turn (turnsFromEvents carries no
     * turn boundaries). Computed only for transcript-override-eligible adapters.
     */
    private sentTranscriptWatermark;
    markerArmCh: Signal;
    inputStateCh: Signal;
    /**
     * The hook drain's independent wake Signal (same primitive as markerArmCh).
     * The spool fs-watch raises it; the drain loop receives it, racing it against
     * the close promise and a BOUNDED fallback timer — so a missed wake can never
     * wedge the tail. Distinct from markerArmCh: hook-event latency is NOT coupled
     * to the turn watcher yielding a live/file event.
     */
    hookDrainCh: Signal;
    /** The active hook drain, when the run opted in AND the adapter supports hooks. */
    hookDrain?: HookDrain;
    currentInput: TurnsInputRequest | null;
    inputSurfaced: boolean;
    writeStdin?: (p: Uint8Array) => void;
    private closedFlag;
    private closedResolve;
    private readonly closedPromise;
    private closeDone;
    constructor(init?: ConversationInit);
    /** The chat-level session ID. */
    sessionID(): string;
    /** The per-harness turns adapter. */
    getAdapter(): Adapter;
    /** A coherent point-in-time view of the rendered terminal. */
    screenSnapshot(): Snapshot;
    /** The channel of turn-state transitions (async-iterable). */
    events(): EventBus;
    /** Block until granted the exclusive control token. FIFO. */
    acquireControl(ctx: Context): Promise<() => void>;
    /** Terminate the harness, release the writer lock, stop the watcher. */
    close(ctx?: Context): Promise<void>;
    isClosed(): boolean;
    /** Transmit a user message; record the user turn and a pending assistant turn. */
    send(ctx: Context, text: string): Promise<string>;
    /** The underlying wrapper session, for callers reaching past the chat API. */
    wrapper(): WrapperSession | undefined;
    /** Ask the harness to exit gracefully via its adapter-defined quit sequence. */
    quit(ctx: Context): Promise<void>;
    /** Respond to the interactive prompt currently awaiting an answer. */
    answer(_ctx: Context, requestID: string, ans: InputAnswer): Promise<void>;
    /** Records a pending request and tries policy/handler resolution, else surfaces. */
    handleInputRequested(req: TurnsInputRequest | undefined): void;
    handleInputResolved(_req: TurnsInputRequest | undefined): void;
    private signalInputState;
    /** A prompt is pending that no policy/handler is resolving. */
    inputAwaitingClient(): boolean;
    /**
     * The interactive prompt currently awaiting a client answer, or null. The
     * polling counterpart of the EventInputRequest event: a caller that missed
     * the event (attached late, single events() consumer elsewhere) can still
     * read the pending question and resolve it via answer().
     */
    pendingInput(): InputRequest | null;
    private writeKeys;
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
    private writeMessageAndSubmit;
    private echoBoundDur;
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
    private awaitComposerEcho;
    private tryAutoDismissCodex;
    private tryResolveInput;
    private policyOption;
    /**
     * NOT async on purpose: validation and the first keystroke write throw
     * synchronously (tryResolveInput's fall-through-to-surface relies on that);
     * only the echo-gated submit tail of the free-text branch is deferred into
     * the returned promise.
     */
    private writeAnswer;
    private consumeWatcher;
    /**
     * The run-level observation: the LARGEST retryAfter seen across every raw
     * wrapper event and whether ANY event reported an api_error mid-run (even one
     * that produced no turn transition, or that later recovered to a different
     * terminal status). Returns the empty observation until consumeWatcher's loop
     * completes. Ports Go's post-terminal Result observation (pkg/harness/run.go).
     */
    observation(): {
        retryAfter: number;
        sawAPIError: boolean;
    };
    handleTurnsEvent(ev: TurnEvent): Promise<void>;
    private idleGapDur;
    private markerGapDur;
    private idleCompletionWatcher;
    private activityIntervalDur;
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
    private activityObserver;
    maybeIdleComplete(): Promise<void>;
    maybeExtractSessionID(): Promise<void>;
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
    private captureAndPersistSessionID;
    /** Extract the id from the current screen and first-write it. True once set. */
    private captureFromScreen;
    private primeBoundDur;
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
    private primeSessionID;
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
    private extractSessionID;
    captureRawSessionID(line: string): Promise<void>;
    history(): Promise<Turn[]>;
    historyWithSource(): Promise<[Turn[], HistorySource]>;
    /**
     * `wholeScreenFallback=false` (the idle-completion, non-marker path) forbids
     * the raw-screen fallback for adapters that CAN extract a message: when their
     * extraction fails there, a ready screen must never be persisted as the
     * reply. Adapters without extractMessage keep the raw-screen fallback — it is
     * their only reply-capture mechanism.
     */
    private assistantText;
    private adapterPromptNotAccepted;
    /**
     * The transcript-backed swallow override applies only to adapters that CAN
     * read their on-disk transcript but CANNOT extract a reply from the screen —
     * today exactly Codex. With extractMessage present the swallow verdict is
     * already extraction-backed (Claude Code), and the transcript must not
     * second-guess it. Structural probes, same pattern as assistantText().
     */
    private transcriptOverrideEligible;
    private readTranscriptTurns;
    /**
     * The transcript turn count immediately before the in-flight submit — the
     * pre-send watermark for transcriptProofOfCurrentTurn. readTranscript is
     * synchronous, so send() pays no new await. Rules: not eligible → null (the
     * proof gate declines before looking); empty harnessSessionID → 0 (fresh
     * session, no prior history); a sentinel read failure (no rollout yet) → 0;
     * any other failure → null ("unknown" — the proof helper then declines
     * rather than guessing a lower bound). Never throws out of send().
     */
    private captureTranscriptWatermark;
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
    private transcriptProofOfCurrentTurn;
    /** One synchronous proof attempt; retryable marks flush-lag-shaped misses. */
    private tryTranscriptProof;
    private adapterBusy;
    private adapterQuitSequence;
    private adapterRawSessionID;
    private waitReadyForSend;
    /**
     * Blocks until the composer prompt is ready for a message. Owns its screen
     * subscription in a try/finally so it always unsubscribes. Throws ctx.err() on
     * cancellation, ErrClosed on close, ErrInputPending on a client-facing prompt.
     * Extracted verbatim from waitReadyForSend's loop.
     */
    private awaitPromptReady;
    /**
     * Same readiness loop as awaitPromptReady but with an extra, NON-throwing exit:
     * when deadlinePromise resolves before the prompt is ready it returns the
     * "deadline" sentinel instead of throwing. The screen subscription is owned in
     * one try/finally so it never leaks on the timeout path (unlike racing a live
     * awaitPromptReady against a timer, which would abandon a subscribed waiter).
     * ctx cancellation still throws ctx.err(); close still throws ErrClosed;
     * a client-facing prompt still throws ErrInputPending.
     */
    private awaitPromptReadyUntil;
    emit(ev: ConversationEvent): void;
    /** Internal: start the watcher + idle pumps. Used by Open. */
    startPumps(): void;
}
/** resolveAdapter maps a harness name to a concrete turns.Adapter. */
export declare function resolveAdapter(name: string): Adapter;
/** Open starts a harness, wires the screen + turn watcher, returns a Conversation. */
export declare function Open(ctx: Context | undefined, opts: Options): Promise<Conversation>;
/**
 * ReopenOptions configures Reopen. `harness` and `workingDir` are omitted because
 * they are derived from the stored Session; `resume` is omitted because it is
 * derived from the stored harnessSessionID. Every other launch knob (binaryPath,
 * env, args, effort, model, cols, rows, inputPolicy, onInputRequest, …) must be
 * supplied by the caller — the stored Session persists ONLY harness, workingDir,
 * and harnessSessionID, so it cannot reconstruct them.
 */
export type ReopenOptions = Omit<Options, "harness" | "workingDir" | "resume"> & {
    /** The chat session id (as returned by Conversation.sessionID()) to reopen. */
    sessionID: string;
};
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
export declare function Reopen(ctx: Context | undefined, opts: ReopenOptions): Promise<Conversation>;
/**
 * Structurally probes an adapter for the optional SessionForkResumer capability.
 * Returns true only when the adapter explicitly reports that `resume` forks the
 * harness session id (mints a new one). Adapters that omit the method — Claude
 * Code, and Codex per the verified finding — default to no-fork.
 */
export declare function adapterResumeForks(adapter: Adapter): boolean;
export { EventBus, Signal };
//# sourceMappingURL=conversation.d.ts.map