import { type Screen, type Snapshot } from "../screen/index.ts";
import { type Adapter, type Event as TurnEvent, type InputRequest as TurnsInputRequest, type Watcher } from "../turns/index.ts";
import { type Session as WrapperSession, type Snapshot as SessionSnapshot } from "../wrapper/index.ts";
import { Context } from "../internal/async/index.ts";
import type { Store } from "./store.ts";
import { type Session, type Turn, type ConversationEvent, type InputRequest, type InputAnswer, type InputPolicy, type HistorySource } from "./types.ts";
import { ControlQueue } from "./control.ts";
import type { RequestedAcquisitionMode } from "../turns/index.ts";
import type { EventEnvelope } from "../transcript/index.ts";
import { StreamTap } from "../acquisition/internal/streamTap.ts";
import { type YieldControl } from "../acquisition/internal/yield.ts";
import { type StreamVersionPredicate } from "../acquisition/internal/planAcquisition.ts";
import { HookDrain } from "./hookDrain.ts";
import type { ParsedEvent, Turn as TranscriptTurn } from "../transcript/event.ts";
import { type PermissionModeReading, type PermissionModeTarget } from "./permission.ts";
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
    /**
     * Launch-time permission posture, translated to the harness's own argv by the
     * wrapper (claude `--permission-mode`, codex `-s`/`-a`). The canonical rungs,
     * least to most permissive, are `plan`, `manual`, `ask`, `auto`, `bypass` —
     * `ask` sits ABOVE `manual` because it auto-accepts edits. claude also accepts
     * its native spellings `acceptEdits`, `bypassPermissions`, `dontAsk`; codex
     * also accepts its native sandbox values `read-only`, `workspace-write`,
     * `danger-full-access` (which set the `-s` axis only).
     *
     * Unset / "" injects nothing, so the harness's own default wins. An explicit
     * permission flag in `args` also wins: the wrapper suppresses injection
     * entirely rather than emitting a second, conflicting spelling.
     */
    permissionMode?: string;
    cols?: number;
    rows?: number;
    /** Backs the chat metadata. Required; pass newMemStore() for the default. */
    store: Store;
    /** Sizes the events buffer. Defaults to 32. */
    eventBuffer?: number;
    /** Pre-configures how blocking interactive prompts are resolved. */
    inputPolicy?: InputPolicy;
    /**
     * Turns off the built-in auto-dismissal of Codex's choice-free startup
     * interstitials (model migration, menu-less "Press enter to continue"
     * notices). The "Update available!" menu is NOT governed by this flag — it
     * surfaces by default and is controlled by autoSkipCodexUpdateNotice.
     */
    disableCodexAutoDismiss?: boolean;
    /**
     * Re-enables the built-in auto-Skip of Codex's "Update available!" menu. The
     * zero value SURFACES that menu on events() (as a codex_update_notice
     * input_request) so a client can choose Update / Skip; set true to have the
     * chat layer transparently select "Skip" (never "Update now") without
     * surfacing it — the safe default for headless/no-client callers (the
     * one-shot run CLI, oneshot loop) that would otherwise wedge on the pending
     * menu. Ignored when disableCodexAutoDismiss is set. An inputPolicy entry for
     * codex_update_notice still takes precedence (it is consulted first).
     */
    autoSkipCodexUpdateNotice?: boolean;
    /** In-process resolver consulted when InputPolicy did not auto-answer. */
    onInputRequest?: (req: InputRequest) => [InputAnswer, boolean];
    /** Test-only idle-completion window override (ms). Zero = package default. */
    idleGap?: number;
    /** Test-only marker-confirm window override (ms). Zero = package default. */
    markerGap?: number;
    /**
     * Test-only per-press permission-settle window override (ms). Zero = package
     * default (permissionSettleGap). Shaped exactly like `markerGap`, and read
     * through permissionSettleDur() the way `markerGap` is read through
     * markerGapDur().
     */
    permissionSettle?: number;
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
     * resolved adapter's capabilities to the LATCHED mode actually used. Accepts
     * the request-only `auto` token ("best available channel"); planAcquisition
     * resolves it and never emits it downstream. Absent ⇒ Off (no live
     * acquisition; the tap is created only if raw session-id capture needs it,
     * exactly as before).
     */
    acquisitionMode?: RequestedAcquisitionMode;
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
    /**
     * Codex-only: the `/status` permission box parsed at PRIME time, stamped with
     * the generation/timestamp of the frame it was read from — or undefined when
     * the box was never observed.
     *
     * It has to be cached because Snapshot is viewport-only (src/screen/screen.ts):
     * the box scrolls off after the first turn, so there is no later frame to
     * re-read. Deliberately SEPARATE from primeOutcome, which describes the ID
     * capture: this subtask decoupled the two, so `primeOutcome === "captured"`
     * with the box never seen is a reachable state. Never set on claude — the
     * claude footer is repainted every frame and is read live, caching nothing.
     *
     * Staleness is UNBOUNDED: codex's `/permissions` rewrites ~/.codex/config.toml
     * globally mid-session, so a caller must weigh `generation`/`observedAt`.
     */
    private primeModeReading?;
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
    /**
     * Reads the live permission mode. PURE: parses `snap` (defaulting to
     * `screenSnapshot()`) plus the prime-time cached codex reading, writes
     * nothing.
     *
     * Pass `snap` when you also need the CURRENT generation for a staleness
     * comparison, so both come from one frame. Safe to call after close(): it
     * returns the last frame's parse with a frozen `generation`.
     *
     * That comparison (the gateway ships it as `stale`) is A GENERATION
     * COMPARISON, NOT A LIVENESS CLAIM: it says only "the frame this reading was
     * parsed from is not the frame you measured". After close() nothing writes,
     * so a closed claude conversation compares equal on a frozen frame; callers
     * distinguish that with isClosed(), never with the generations.
     *
     * It NEVER touches the PTY — no `/status` write, no keystrokes, no store
     * mutation. A getter that writes is a trap: on codex it would mutate the
     * session, and `/status` mid-turn is refused anyway. An explicit re-probe
     * belongs behind a control-token-gated refreshPermissionMode().
     *
     * Per harness:
     *  - `claude-code` — a STRICT LIVE read of `snap`. The footer is repainted
     *    every frame, so this is cheap and always current, and it is the only
     *    semantics that cannot hand back a stale value dressed as a live one.
     *    Nothing is cached; when the footer is absent (claude's blocking trust /
     *    bypass dialogs, or a mid-render frame) it reports `observed: "unknown"`
     *    with `source: "no_footer"` — come back next frame.
     *  - `codex` — the `/status` box cached at prime time (Snapshot is
     *    viewport-only, so the box is gone after the first turn). Staleness is
     *    UNBOUNDED: `/permissions` rewrites ~/.codex/config.toml globally
     *    mid-session, so weigh `generation`/`observedAt`. When the box was never
     *    observed, `source` says why, derived from the prime outcome.
     *  - everything else — no screen reader exists, so `observed: "unknown"` with
     *    `source: "launch"`; only `requested`/`requestedRaw` carry information.
     *
     * KNOWN HOLE (reported honestly, never guessed): a resumed/reopened codex
     * conversation never renders a `/status` box at all — openWithSession gates
     * the prime on `!opts.resume` and primeSessionID returns early once
     * harnessSessionID is seeded — so its reading is permanently
     * `source: "not_primed"` until an explicit refresh lands.
     */
    permissionMode(snap?: Snapshot): PermissionModeReading;
    /** The channel of turn-state transitions (async-iterable). */
    events(): EventBus;
    /** Block until granted the exclusive control token. FIFO. */
    acquireControl(ctx: Context): Promise<() => void>;
    /** Terminate the harness, release the writer lock, stop the watcher. */
    close(ctx?: Context): Promise<void>;
    isClosed(): boolean;
    /** Transmit a user message; record the user turn and a pending assistant turn. */
    send(ctx: Context, text: string): Promise<string>;
    private emitAuthRequiredTurn;
    /** The underlying wrapper session, for callers reaching past the chat API. */
    wrapper(): WrapperSession | undefined;
    /** Ask the harness to exit gracefully via its adapter-defined quit sequence. */
    quit(ctx: Context): Promise<void>;
    /**
     * Moves the live session onto `target` by driving the harness's OWN
     * permission-mode cycle keystroke, and returns permissionMode()'s reading once
     * the harness's own UI shows the new value on the axis this method drives — or
     * throws. WRITES. Requires the control token as a PRECONDITION.
     *
     * ## Locking: `held()`, NOT `acquire()`
     *
     * This copies send()/answer() exactly — `closedFlag` then `queue.held()` — and
     * MUST NEVER `await this.queue.acquire(ctx)`. The gateway mints the control
     * token BY HOLDING the ControlQueue (acquireControl -> conv.acquireControl ->
     * entry.acquireToken(release), src/gateway/server.ts), and ControlQueue is a
     * non-reentrant FIFO with a single `_held` flag (src/chat/control.ts). An
     * acquire() here would park an HTTP caller behind its OWN token until the
     * request deadline — a deadlock, not a style question.
     *
     * quit() is deliberately DIFFERENT (it acquires, and has no token gate at all)
     * because it is the teardown path: it must be callable by an owner that never
     * took control, and nothing races it afterwards. Do NOT "unify" the two.
     *
     * Be honest about what the precondition buys: ControlQueue.held() reports that
     * SOMEONE holds the token, not that THIS caller does. This method inherits
     * exactly the precondition send()/answer() already have, including that known
     * limitation. Over HTTP the real gate is `entry.hasToken(...)` in the gateway.
     *
     * Makes NO store mutation.
     *
     * ## Gating, in order, before a single keystroke
     *
     *  1. not closed                     -> else ErrClosed
     *  2. `queue.held()`                 -> else ErrNoControl
     *  3. `currentTurn === null`         -> else ErrTurnInFlight (a press mid-turn
     *     moves the mode while the footer is repainting and unreadable, so the
     *     loop could not confirm anything)
     *  4. `currentInput === null`        -> else ErrInputPending
     *  5. `readyForInput(...)`           -> else wait under awaitPromptReadyUntil
     *     rather than writing blind. This one gate also covers a blocking startup
     *     interstitial, an approval dialog, and codex's `Update Model Permissions`
     *     dialog, all of which pin readyForInput false.
     *  6. the target is legal for this harness's axis, and the START value is
     *     on-axis.
     *
     * The static half of (6) — plus the adapter capability probe and the `bypass`
     * launch-configuration check — is evaluated BEFORE (5): all three are pure
     * facts about the adapter and the launch, so failing them fast beats burning
     * the caller's deadline waiting for a composer we are then going to refuse.
     * Still zero keystrokes either way. The start-value half genuinely needs a
     * legible screen, so it runs after (5).
     *
     * ### Gate 4 diverges from the rest of the layer ON PURPOSE
     *
     * It is the STRICT `currentInput !== null`, where the rest of chat uses the
     * looser inputAwaitingClient() (`currentInput !== null && inputSurfaced`) —
     * which is also what gate 5's awaitPromptReadyUntil re-checks mid-wait. The
     * consequence, documented rather than left to be discovered: a NON-auto-
     * dismissable codex interstitial (`KindPermissions`, whose AutoDismissKeys
     * returns `[null, false]` BY DESIGN, src/turns/harness/codex.ts) parks
     * `currentInput` indefinitely, so this method fails PERMANENTLY with
     * ErrInputPending until a client answers it. That is correct, but to a caller
     * it looks like a hang — so the raised ErrInputPending names the pending
     * request's `kind` and points at pendingInput() / answer().
     *
     * Precedence, stated the way autoSkipCodexUpdateNotice states its own: THE
     * INPUT MACHINERY WINS. This method refuses whenever `currentInput !== null`,
     * INCLUDING a request currently being auto-resolved by an inputPolicy via
     * tryResolveInput/writeAnswer. It never writes "around" a pending prompt.
     * Callers that want to answer a prompt use answer(); callers that want to move
     * the mode use this.
     *
     * A dialog can also appear MID-TRAVERSAL: on a bypass-enabled claude session
     * with a fresh HOME, a ring traversal that lands on `bypass` surfaces the
     * acceptance screen ("Bypass Permissions mode"), which the turns layer reports
     * as `kind: "trust_prompt"`. The loop therefore re-checks `currentInput`
     * before every press and on every frame of every settle, and aborts with
     * ErrInputPending naming the kind — NOT with a stall while leaving the session
     * parked in a modal. The caller clears it with answer().
     *
     * ## Per-harness axis
     *
     *   harness       axis driven                field       legal targets
     *   claude-code   the Shift+Tab ring         `observed`  any PermissionRung
     *                 (= the ladder)                         (`bypass` only when
     *                                                        launch-enabled)
     *   codex         the collaboration 2-cycle  `collaboration`  "default"|"plan"
     *   others        none                       —           none -> Unsupported
     *
     * A rung target on codex, or `"default"` on claude, is
     * ErrPermissionModeUnreachable naming the axis and pointing at the launch
     * flags (`-s` / `-a` on codex). (`"default"` is not a ladder rung: the rule is
     * "Default when permissionMode is unset: inject nothing", and claude's actual
     * default is `manual`.) On codex `"plan"` is ALWAYS the collaboration mode,
     * never the ladder rung of the same name.
     *
     * ## codex: the `/status` confirmation, and what a success does NOT claim
     *
     * The mechanism is Shift+Tab and ONLY Shift+Tab — the same
     * adapterPermissionCycleKeys() the claude ring uses. The collaboration axis is
     * a 2-cycle (Default ⇄ Plan), so one press toggles; lap detection covers a
     * 2-long ring unchanged. This IS the epic's post-launch collaboration step, so
     * nothing else may grow a competing `/plan` writer.
     *
     * There is NO footer fast path: 102 reads `collaboration` from the positive
     * `│ Collaboration mode: … │` row of the `/status` box only, and the
     * ` Plan mode (shift+tab to cycle)` composer marker never feeds that field.
     * So this method runs the internal `/status` probe ONCE BEFORE the first press
     * (to establish `start`) and ONCE AFTER each settled press (to confirm). The
     * prime-time cached reading is NEVER trusted for a write decision.
     *
     * Bounded cost, asserted by test: a no-op writes exactly ONE `/status` burst
     * and ZERO cycle keystrokes; a toggle writes exactly TWO bursts and ONE cycle
     * keystroke. (The zero-write guarantee is scoped to CYCLE keystrokes — the
     * probe is a write, and has to be.)
     *
     * KNOWN AND CONTAINED, not fixed: a Shift+Tab landing inside codex's
     * MCP-server boot window is SWALLOWED even though the `›` composer is painted
     * and readyForInput() returns true (measured — test/corpus/codex/
     * permission-mode-cycle-boot-window). The per-press `/status` confirm turns
     * that into ErrPermissionModeStalled ("the permission axis did not change
     * after press 1"), never a silent wrong mode. Holding the first press until
     * that window closes is follow-up work, not this method's.
     *
     * A successful codex call returns 102's reading UNCHANGED IN SHAPE:
     * `collaboration === target`, with `observed` still reporting the LAUNCH
     * permissions rung. Per META-HARNESS-99 codex's canonical `plan` rung is
     * `-s read-only -a untrusted` PLUS the collaboration flip; this method supplies
     * only the second half and does not claim the rung.
     *
     * ## Honest-return guarantees
     *
     * `requested` is a LAUNCH fact and is NOT rewritten by a successful switch:
     * after this call `requested` still reports the rung the session was LAUNCHED
     * with, so `requested !== observed` is expected drift, not a bug. Callers
     * comparing the two go through normalizePermissionRung.
     *
     * On codex this method moves the COLLABORATION axis only. The permissions axis
     * is launch-flag territory (`-s` / `-a`), and the only way to move it at
     * runtime is the opt-in `/permissions` dialog driver — which writes
     * `~/.codex/config.toml` and so LEAKS OUT OF THE SESSION. Nothing here writes
     * that file. Claude's Shift+Tab and codex's collaboration toggle are both
     * session-local.
     *
     * ## Termination
     *
     * Lap detection is the terminator: `start` is recorded before the first press,
     * and the axis returning to `start` without ever hitting `target` means the
     * ring lapped -> ErrPermissionModeUnreachable LISTING the values actually
     * observed. That is exact whether this session's ring is 4 or 5 long, and it
     * also catches a hypothetical extra rung on a future build. A flat
     * permissionCycleMaxPresses backstop and the ctx deadline each raise
     * ErrPermissionModeStalled. A fixed number of presses is NEVER sent: the ring
     * length is launch-dependent and no code may depend on it, so the axis is
     * re-read after EVERY press.
     *
     * No-op: `target` already on the axis returns the current reading without
     * writing a single cycle keystroke, and without touching the queue beyond the
     * held() precondition. Idempotent by construction — two consecutive calls
     * press at most once.
     */
    setPermissionMode(ctx: Context, target: PermissionModeTarget): Promise<PermissionModeReading>;
    /**
     * The ONE axis accessor every comparison in setPermissionMode goes through —
     * before/after, the no-op check, the target hit, and lap detection.
     *
     * 102's reading carries TWO axes that DO NOT COLLAPSE: `observed` is the
     * PERMISSIONS ladder, `collaboration` is a separate field. Watching the wrong
     * field is the failure that would make every codex call end in
     * ErrPermissionModeStalled after the backstop — which is why this is a named
     * function with its own test rather than an inline field access repeated in
     * four places.
     *
     * Returns "unknown" for a harness with no cycle axis. Those never reach here
     * (the capability probe raises ErrPermissionModeUnsupported first), but a
     * silent fallback to `observed` would make a future harness look like it had a
     * ladder axis it does not have.
     */
    private permissionAxisValue;
    /**
     * The adapter's permission-mode cycle keystroke, or null.
     *
     * A verbatim copy of adapterQuitSequence's shape, and consumed the same way
     * quit() consumes it for ErrQuitUnsupported. The `permissionCycleKeys?()`
     * declaration in src/chat/deps.ts is DOCUMENTATION of the optional-capability
     * set, not compile-time checking — this runtime `typeof … === "function"`
     * probe plus the turns-layer contract test are the only real guards.
     */
    private adapterPermissionCycleKeys;
    /**
     * Whether this session's LAUNCH CONFIGURATION enables the `bypass` rung — i.e.
     * whether `bypass` is on this session's Shift+Tab ring at all.
     *
     * META-HARNESS-100 landed the launch-configuration predicate as
     * effectiveLaunchRung rather than the anticipated
     * `bypassEnablingFlagPresent(mode, args)` shape. We reuse it verbatim instead
     * of hand-rolling a flag scanner in the chat layer: it reads BOTH the
     * structured knob and argv, including the `=`-joined
     * `--permission-mode=bypassPermissions` form and the
     * `--dangerously-skip-permissions` family, which is exactly the fact needed.
     */
    private bypassEnabledAtLaunch;
    /**
     * The STRICT pending-input refusal, carrying the pending request's `kind`.
     *
     * Deliberately `currentInput !== null` rather than inputAwaitingClient(): see
     * setPermissionMode's docstring for why, and for the permanent-failure case it
     * implies. The message names the kind and the escape hatch because to a caller
     * a permanent ErrInputPending otherwise looks like a hang.
     */
    private throwIfPermissionInputPending;
    /**
     * Classifies a reading whose axis value is "unknown", keyed on `source` — NOT
     * on `observed === "unknown"`, which on a single mid-render frame would kill
     * the whole call. Returns null when the reading is merely TRANSIENT and the
     * caller should keep waiting inside the settle bound.
     *
     *   source                        meaning                  disposition
     *   no_footer                     mid-render, or a          keep waiting
     *                                 blocking dialog is up     (null)
     *   unparsed_footer               the line IS painted and   Stalled + source
     *                                 did not parse             + raw
     *   too_narrow / not_primed /     the codex /status box     Stalled + source
     *   not_written /                 was never legibly
     *   written_uncaptured            captured
     *   "unknown" + NON-EMPTY raw     off-ladder but LEGIBLE    Unreachable,
     *                                 (dontAsk, codex           quoting raw
     *                                 `Custom (…)`, `Workspace
     *                                 (Approve for me)`)
     *
     * A blocking dialog reads as `no_footer` here, and would therefore be waited
     * on — but it also trips the mid-loop `currentInput` check, which raises
     * ErrInputPending first. That ordering is the point: the caller learns there
     * is a modal to answer, not that the ring stalled.
     */
    private permissionReadingError;
    /**
     * Waits for the permission axis to hold a usable value, under a SINGLE screen
     * subscription taken BEFORE `write` runs — so a render landing between the
     * write and the subscription is never missed. This is primeSessionID's
     * check-before-wait + single-subscription pattern.
     *
     * `before === null` is the ENTRY read: no write, and the first legible value
     * is accepted immediately (nothing is moving, so demanding stability would
     * cost a whole settle gap on every no-op call).
     *
     * Otherwise it is the PER-PRESS settle, and the naive "write, re-read, repeat"
     * is exactly what it exists to prevent: an immediate re-read races the render,
     * sees the pre-press value, concludes "not there yet", presses again and
     * OVERSHOOTS the ring — the silent-wrong-mode failure. A new value V is
     * accepted only when it differs from `before` AND is STABLE, where stability
     * is defined by the screen GENERATION and the timer is only the bound:
     *
     *   - V parses identically at two DISTINCT generations (the sharp, cheap
     *     predicate — claude repaints continuously, so this resolves in ms), OR
     *   - V parsed at least once and no further render arrives before
     *     permissionSettleGap elapses (the quiescent case, where a second
     *     generation will never come).
     *
     * Returns null when the bound elapsed with no stable change; throws on ctx
     * cancellation, close, a pending input request, or a non-transient reading
     * failure.
     */
    private settlePermissionAxis;
    /**
     * Codex-only re-probe: writes `/status`, re-parses the box, and REFRESHES
     * 102's cached codex reading. Requires the control token. On claude it is a
     * no-op alias for permissionMode().
     *
     * This is the CONFIRMATION half of the mid-session switch. On codex the
     * collaboration axis is readable ONLY from the `/status` box; permissionMode()
     * is pure and must never write the PTY; and the prime-time cache is
     * UNBOUNDED-stale (`source: "not_primed"` outright on every resumed/reopened
     * session). Without an explicit refresh there is no way to close the loop.
     *
     * ## Locking — the same `held()`-NOT-`acquire()` precondition as
     * setPermissionMode
     *
     * The gateway mints the control token BY HOLDING the non-reentrant
     * ControlQueue, so acquiring here would park an HTTP caller behind its own
     * token. The shared probe (probeCodexStatus) therefore does NOT touch the
     * queue either — primeSessionID acquires around it, this method does not. See
     * setPermissionMode's locking section; the gates are identical (closed ->
     * held() -> currentTurn === null -> currentInput === null -> readyForInput,
     * the last one inside the probe).
     *
     * ## The write-back is the point
     *
     * The refreshed reading is stored into the SAME private field the primer
     * writes, with the new `generation`/`observedAt`. 102's `permissionMode()` on
     * codex serves that cache and `GET /v1/conversations/:id/permission-mode` is a
     * pure read of it — so without the write-back a refresh would return a fresh
     * value while the very next GET still returned the prime-time one (or
     * `not_primed`), and the two routes would disagree.
     *
     * On claude this is a PLAIN ALIAS for permissionMode() — for EVERY rung,
     * `manual` included: 102's claude path is a strict live per-call footer parse
     * that caches nothing, so there is nothing to re-probe. It still takes the
     * gates, so a caller cannot use it as an ungated read (permissionMode() is
     * that).
     *
     * Throws ErrPermissionModeStalled when the box never rendered a legible
     * `Collaboration mode:` row inside the probe bound; the cached reading is left
     * exactly as it was.
     */
    refreshPermissionMode(ctx: Context): Promise<PermissionModeReading>;
    /**
     * One codex `/status` probe, turned into the settlePermissionAxis-shaped
     * contract the setPermissionMode loop consumes: a reading, or null when the
     * box never carried a usable value inside the bound.
     *
     * `write` (the cycle keystroke) runs FIRST, before the probe, exactly as
     * settlePermissionAxis runs it inside its own subscription — the probe's write
     * is the `/status` burst that follows.
     *
     * `before` is the axis value to beat. Non-null means "reject a box still
     * reporting `before`", which is what makes the confirm honest: the box already
     * on screen is the PREVIOUS probe's, so a probe that accepted it would read
     * the pre-press value and call the press dead. `before === null` is the ENTRY
     * probe and accepts the first positive `Collaboration mode:` row.
     *
     * null vs throw, deliberately split:
     *   - `written_uncaptured` (the burst went out, no usable box) -> null, so the
     *     CALLER writes its own prose ("did not change after press N" / "could not
     *     read the axis before pressing anything"), identical to the claude path.
     *   - `too_narrow` / `not_written` -> Stalled here: nothing was written at
     *     all, and neither is a "the press did not take" story.
     * ErrClosed / ErrInputPending pass straight through; a ctx bound becomes null
     * so the caller reports it as its own deadline (it re-checks ctx before
     * spending another press).
     */
    private confirmCodexCollaboration;
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
    private permissionSettleDur;
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
     * Write-once-after-"captured" setter for primeOutcome.
     *
     * primeOutcome is LOAD-BEARING, not diagnostic: maybeExtractSessionID's
     * first-write branch passes `primeOutcome === "written_uncaptured"` as
     * extractSessionID's allowDiskFallback, so a stray downgrade would arm the
     * disk-locate backstop on a session whose id was already scraped. Until the
     * mode capture was decoupled from the id capture, an early id `return`ed out
     * of the prime loop and no later assignment could land; now the loop stays
     * alive for the box, so BOTH the tail classification and the ErrInputPending
     * catch can run after a capture. One guarded setter, not two ad-hoc `if`s.
     */
    private setPrimeOutcome;
    /**
     * Parses the codex `/status` permission box off the CURRENT frame into
     * primeModeReading. Returns true once the box has been captured (idempotent:
     * a later frame never overwrites the first observation).
     *
     * "Captured" means a `Permissions:` row actually matched — i.e. `raw` is set.
     * The row regexes require their closing │ on the same physical line, so a
     * wrapped/truncated box fails CLOSED and we keep polling rather than caching a
     * half-read value. Called only from the prime loop, which runs under the
     * control token; the read itself writes nothing.
     */
    private captureModeFromScreen;
    /**
     * The REFRESH counterpart of captureModeFromScreen: re-parses the `/status`
     * box off the CURRENT frame and REPLACES the cached reading (rather than
     * latching the first observation), stamping it with this frame's generation
     * and the current time. Returns true once a usable box was read.
     *
     * Two deliberate differences from the primer's capture:
     *
     *  - The predicate is the positive `│ Collaboration mode: … │` row, not the
     *    `Permissions:` row: the collaboration axis is what a refresh exists to
     *    re-read, and absence is never a signal (a missing row is "unknown", so it
     *    is rejected and the poll continues).
     *  - It accepts ONLY a frame NEWER than the probe's own `/status` write
     *    (`sinceGeneration`, sampled immediately before that write). A box already
     *    on screen is a PREVIOUS probe's — the primer's, or the one this loop
     *    printed before the cycle keystroke — and "refresh" that hands back the
     *    box printed before the write is not a refresh at all: it would report the
     *    pre-press value and declare the press dead. `before` is the SECOND
     *    filter, and the one that keeps a press that genuinely did not take
     *    reporting "did not change" rather than a spurious lap; null (the entry
     *    probe / an explicit refresh) accepts any value from a new-enough frame.
     *
     * It writes the SAME private field the primer writes, which is what keeps
     * refreshPermissionMode and the pure GET route from disagreeing.
     */
    private refreshModeFromScreen;
    /**
     * Whether the CONFIGURED width is too narrow for the `/status` box to render
     * unwrapped — the write gate both `/status` writers share.
     *
     * `this.opts.cols` is the configured width, NOT a live measurement: that is
     * precisely what `source: "too_narrow"` means. Below the documented minimum
     * the box wraps, the row-anchored scrapes fail closed, and writing would only
     * spend a burst to learn nothing.
     */
    private codexStatusTooNarrow;
    /**
     * The ONE `/status` writer in this class: writes the adapter's
     * primeSessionIDKeys burst, then polls `done()` under a SINGLE screen
     * subscription taken BEFORE the write, re-sending ONCE at the halfway mark if
     * something is still missing and the composer is ready.
     *
     * Shared verbatim by primeSessionID (startup id + box capture) and
     * confirmCodexCollaboration (the post-Open re-probe behind
     * refreshPermissionMode / setPermissionMode). The `/status` write is flaky
     * enough that the primer already re-sent once at the halfway mark; the refresh
     * has the same failure mode and takes the same treatment, so the write, the
     * subscription, the resend latch and the deadline live here ONCE.
     *
     * TWO CARVE-OUTS, both load-bearing:
     *
     *  1. THE QUEUE ACQUISITION STAYS OUTSIDE. primeSessionID acquires the
     *     ControlQueue around this call; refreshPermissionMode/setPermissionMode
     *     must NOT — they take `queue.held()` as a PRECONDITION because the
     *     gateway mints the control token by HOLDING the non-reentrant queue, and
     *     an acquire() here would re-introduce exactly the self-deadlock
     *     setPermissionMode's locking docstring exists to prevent.
     *  2. THE SUCCESS PREDICATE IS A PARAMETER. The callers genuinely differ: the
     *     primer wants the session id AND the box; the refresh wants the
     *     `Collaboration mode:` row re-parsed. This helper owns only the write,
     *     the subscription, the resend latch and the deadline — never what
     *     "finished" means. `done` receives the screen generation sampled
     *     IMMEDIATELY BEFORE the write, so a caller that must not accept a box
     *     printed by an EARLIER probe can say so; the primer ignores it (its box
     *     is by definition the first one).
     *
     * The burst is written with writeKeys(a.primeSessionIDKeys()) — the proven
     * mechanism (`/status` + CSI 13u as ONE burst, src/turns/harness/codex.ts).
     * NOT writeMessageAndSubmit: that splits text from submit and waits on
     * awaitComposerEcho, an echo wait built against free-text prompt echo and
     * unproven against a slash command (codex pops a completion menu). The paste
     * hazard writeMessageAndSubmit exists to dodge (META-HARNESS-21/24) is a
     * free-text-prompt hazard, not one this already-validated burst has.
     *
     * Throws ctx.err() on cancellation and ErrClosed on close; ErrInputPending
     * propagates from the readiness wait (which is the ONLY place it can arise,
     * and it is strictly BEFORE the write).
     */
    private probeCodexStatus;
    /**
     * Why the codex `/status` box was never observed — a TOTAL function of the
     * prime outcome, reusing primeOutcome's vocabulary rather than paralleling it.
     *
     * `"written_uncaptured"` is literally accurate for the `"captured"` row: the
     * id landed (possibly from a `codex resume` hint that carries no box at all),
     * `/status` WAS written, and the box was NOT captured.
     */
    private codexUnobservedSource;
    /**
     * Primes the harness session id at first idle by writing the adapter's
     * primeSessionIDKeys (Codex: `/status`), which renders the id on screen, then
     * capturing it — all before Open returns the handle. Bounded by an internal
     * deadline so Open can never hang; a capture miss is non-fatal (the `/quit`
     * hint and the first TurnComplete re-scrape remain backstops). Only
     * lifecycle/IO failures — ctx cancellation, ErrClosed, or a writeKeys throw —
     * are fatal and propagate to openWithSession's cleanup. Records the outcome in
     * primeOutcome for tests.
     *
     * ## No longer the ONLY `/status` writer
     *
     * This used to claim "no public method can race the primer". That is still
     * true DURING the prime (public methods need the handle Open has not returned
     * yet, and send/answer additionally need the control token the primer holds),
     * but refreshPermissionMode is a SECOND, POST-OPEN writer of the same
     * `/status` burst through the shared probeCodexStatus helper. Its three
     * hazards, answered rather than left open:
     *
     *  - THE NEXT TURN'S REPLY SCRAPE. Codex implements no extractMessage, so
     *    assistantText() falls back to `snap.text` — the WHOLE screen. A `/status`
     *    box still visible when the next turn settles can therefore appear inside
     *    that turn's scraped text. Not new IN KIND (the primer already leaves a box
     *    on screen before the first turn) but new in FREQUENCY. Containment: the
     *    `currentTurn === null` gate guarantees a probe never lands inside an
     *    in-flight turn, and the driver MUST NOT invent a screen-clearing keystroke
     *    (no ESC, no Ctrl-L) to tidy up — that would be an unvalidated write. The
     *    behaviour is pinned by a deterministic test.
     *  - history(). Codex has a readTranscript adapter and historyWithSource
     *    prefers the harness transcript, so transcript-sourced history is
     *    unaffected; only the screen-scraped FALLBACK can carry the box.
     *  - promptNotAccepted's byte-identical heuristic. Signal 1 compares the
     *    settled screen against `sentScreenText`, captured AT SEND TIME — which is
     *    necessarily AFTER any probe, since a probe can only run when
     *    `currentTurn === null`. So a probe can never make the settled screen
     *    byte-identical to a `sentScreenText` captured before it. Signal 2 (the
     *    last `›` row still carrying text) is unaffected: `/status` submits and
     *    leaves the composer empty.
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
    private cleanAssistantText;
    private authRelabel;
    private usageLimitRelabel;
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
/**
 * launchInputPolicy returns the InputPolicy the Conversation is constructed
 * with: the caller's, except that a claude `bypass` launch with no trust_prompt
 * disposition gets a built-in "proceed" answer.
 *
 * Why: selecting the bypass rung sets no env, so on a fresh HOME claude paints
 * its blocking "Bypass Permissions mode" screen (claudeBypassAnchor → a
 * claudeBlockingDialog that pins readyForInput false). One-shot callers already
 * install oneshot's AutoAcceptTrust; a gateway/chat caller that passes no
 * inputPolicy would instead get a surfaced input_request and an Open that never
 * returns a usable handle. We do NOT inject IS_SANDBOX=1 to dodge the dialog —
 * that would contradict the "env is forwarded verbatim" contract buildGuestEnv
 * states — so the default is a policy, not an env edit.
 *
 * Precedence — the CALLER'S POLICY ALWAYS WINS, mirroring how
 * autoSkipCodexUpdateNotice yields to an explicit codex_update_notice entry.
 * The default fires only when resolvePolicy(opts.inputPolicy, "trust_prompt")
 * is null, i.e. the caller supplied neither a byKind.trust_prompt entry nor a
 * bare `default` disposition. optionID "proceed" resolves through findOption's
 * alias match: claude's parseMenuOptions sets `id` to the menu number and
 * `alias` to "proceed", exactly as AutoAcceptTrust already relies on.
 *
 * Gated on the HARNESS as well as the rung: a codex bypass would otherwise
 * install a trust_prompt disposition no codex dialog ever produces — inert, but
 * it makes the intent unreadable.
 *
 * openWithSession backs both Open and Reopen, so a resumed session inherits the
 * same default.
 */
export declare function launchInputPolicy(opts: Pick<Options, "harness" | "permissionMode" | "inputPolicy">): InputPolicy | undefined;
/** resolveAdapter maps a harness name to a concrete turns.Adapter. */
export declare function resolveAdapter(name: string): Adapter;
/** Open starts a harness, wires the screen + turn watcher, returns a Conversation. */
export declare function Open(ctx: Context | undefined, opts: Options): Promise<Conversation>;
/**
 * ReopenOptions configures Reopen. `harness` and `workingDir` are omitted because
 * they are derived from the stored Session; `resume` is omitted because it is
 * derived from the stored harnessSessionID. Every other launch knob (binaryPath,
 * env, args, effort, model, permissionMode, cols, rows, inputPolicy,
 * onInputRequest, …) must be supplied by the caller — the stored Session persists ONLY harness, workingDir,
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
 * permissionMode is a launch-ARG knob, so it applies on resume exactly as it does
 * on a fresh Open: the translated permission argv is prepended alongside the
 * adapter's resume prefix, and the explicit-override-wins guard still holds — an
 * explicit permission flag carried by the resume args themselves suppresses
 * injection. The claude bypass trust-prompt default (see launchInputPolicy) is
 * inherited too, since openWithSession backs both entry points.
 *
 * Caveat for codex: a resumed session ALSO inherits whatever `~/.codex/config.toml`
 * holds globally, so the REQUESTED rung is not necessarily the EFFECTIVE one.
 * Learning the effective rung is a readback concern (META-HARNESS-102's
 * refreshPermissionMode()), not something this launch knob can report.
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