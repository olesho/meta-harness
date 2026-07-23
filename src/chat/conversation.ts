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

import { newScreen, type Screen, type Snapshot } from "../screen/index.ts";
import {
  Watch,
  type Adapter,
  type Event as TurnEvent,
  type InputRequest as TurnsInputRequest,
  type InputOption as TurnsInputOption,
  type Watcher,
  TurnComplete,
  ToolCall,
  Blocked,
  Errored,
  InputRequested,
  InputResolved,
  generic,
  claudecode,
  codex,
  opencode,
  pi,
} from "../turns/index.ts";
import {
  start as wrapperStart,
  type Session as WrapperSession,
  type Snapshot as SessionSnapshot,
} from "../wrapper/index.ts";
import { Context, isSentinel, wrap } from "../internal/async/index.ts";
import { ErrEmptySessionID, ErrSessionNotFound } from "../transcript/errors.ts";
import { stripIDEContextTags } from "../transcript/stripTags.ts";
import type { Store } from "./store.ts";
import {
  type Session,
  type Turn,
  type ConversationEvent,
  type InputRequest,
  type InputAnswer,
  type InputPolicy,
  type Disposition,
  type HistorySource,
  RoleUser,
  RoleAssistant,
  TurnStatePending,
  TurnStateComplete,
  TurnStateErrored,
  EventTurn,
  EventInputRequest,
  EventInputResolved,
  DispositionAnswer,
  DispositionDeny,
  HistorySourceTranscript,
  HistorySourceStore,
  ReasonAuthRequired,
  ReasonUsageLimited,
  newID,
} from "./types.ts";
import {
  ErrInvalidOptions,
  ErrUnknownHarness,
  ErrNoControl,
  ErrTurnInFlight,
  ErrClosed,
  ErrInputPending,
  ErrAuthRequired,
  ErrNoInputPending,
  ErrStaleInputRequest,
  ErrUnknownOption,
  ErrNotMultiSelect,
  ErrQuitUnsupported,
  ErrPermissionModeUnsupported,
  ErrPermissionModeUnreachable,
  ErrPermissionModeStalled,
  ErrResumeUnsupported,
  ErrNoHarnessSession,
} from "./errors.ts";
import { ControlQueue, newControlQueue } from "./control.ts";
import {
  submitKeyForHarness,
  requiresPromptReadiness,
  readyForInput,
  authRequired,
  onboardingWall,
  usageLimitMessage,
} from "./ready.ts";
import { cleanHarnessEnv } from "./env.ts";
import type { RequestedAcquisitionMode } from "../turns/index.ts";
import { AcquisitionModeOff, AcquisitionModeHooks } from "../turns/index.ts";
import type { EventEnvelope } from "../transcript/index.ts";
import {
  StreamTap,
  adapterStreamParser,
} from "../acquisition/internal/streamTap.ts";
import { newDisplaySink } from "../acquisition/internal/display.ts";
import { hookEnv, type YieldControl } from "../acquisition/internal/yield.ts";
import {
  planAcquisition,
  resolveProfile,
  type StreamVersionPredicate,
} from "../acquisition/internal/planAcquisition.ts";
import { HookDrain } from "./hookDrain.ts";
import type { HookProvider } from "../hooks/provider.ts";
import type {
  ParsedEvent,
  Turn as TranscriptTurn,
} from "../transcript/event.ts";
import {
  EnvConfigDir,
  EnvConfigDirDeprecated,
  EnvSessionID,
} from "../cli/hooks.ts";
import { normHarness } from "../wrapper/internal/harnessargs.ts";
import {
  ClaudeModeBypassPermissions,
  PermissionModeBypass,
  effectiveLaunchRung,
} from "../wrapper/internal/permissionrungs.ts";
import {
  normalizePermissionRung,
  parsePermissionMode,
  type PermissionModeReading,
  type PermissionModeSource,
  type PermissionModeTarget,
} from "./permission.ts";

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

  // ── Activity observer (periodic wrapper-session liveness snapshot) ──────────
  // A periodic ticker that samples the WRAPPER-SESSION snapshot (carrying
  // lastOutputAt) and hands it to onActivity, plus one final sample taken at
  // close() BEFORE the session is stopped. Ports Go's startActivityObserver /
  // OnActivity / ActivityInterval (pkg/harness/run.go). Harness-independent: it
  // fires regardless of prompt-readiness. Inert unless onActivity is set.
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

  // ── Acquisition (StreamTap) opt-in ─────────────────────────────────────────
  // The acquisition subsystem attaches as an ADDITIONAL consumer of the SAME
  // durable PTY line tap chat already uses for raw session-id capture — no second
  // launch, no second PTY reader. The rendered Screen + turn watcher remain the
  // sole turn-state authority. These fields are inert unless the resolved plan is
  // Stream (planAcquisition), which — for A1's real adapters — it never is.

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

  // ── Hook drain (spool → canonical-Event runtime integration) opt-in ──────────
  // Inert unless onHookEvents is set AND the resolved adapter implements the
  // HookProviderCapability (Claude Code). When active, a HookDrain owns a spool
  // dir under the harness config dir, installs the managed settings.json block,
  // watches the spool for out-of-process hook writes, and drains them on its own
  // wakeup (independent of the turn watcher) into the durable-store/dedup layer.
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

const enc = new TextEncoder();

// idleCompletionGap — how long the screen must sit unchanged at the ready prompt
// before the idle fallback completes an in-flight turn. (ms)
const idleCompletionGap = 8000;
// markerConfirmGap — the shorter quiet window used once an end-of-turn marker has
// been seen. (ms)
const markerConfirmGap = 2000;
// permissionSettleGap — the QUIESCENT bound on one permission-mode press: how
// long setPermissionMode waits for the axis to settle after writing a single
// cycle keystroke, when no further render arrives. (ms)
//
// It is a BOUND, not the stability predicate. Stability is defined by the screen
// GENERATION: a new axis value is accepted the moment it parses identically at
// two DISTINCT generations, which on claude — whose footer repaints continuously
// — resolves in milliseconds and never touches this timer. The timer only covers
// the quiescent case, where a second generation will never come, so a value that
// parsed exactly once is still accepted rather than reported as a stall.
//
// Deliberately shorter than markerConfirmGap: a mode press repaints one footer
// line, not a whole turn's output.
const permissionSettleGap = 750;
// permissionCycleMaxPresses — a flat INFINITE-LOOP GUARD on setPermissionMode,
// nothing more.
//
// The real terminator is lap detection (the axis returning to its start value
// without ever hitting the target), which is exact whatever the ring's length.
// This constant exists only so a harness that somehow never laps cannot spin
// forever. 8 clears both measured rings — 4 launched normally, 5 with a
// bypass-enabling flag — with room to spare, and makes NO claim beyond that: no
// code may derive a ring length from it.
const permissionCycleMaxPresses = 8;

/**
 * The legal setPermissionMode targets per harness — the table half of the axis
 * story that permissionAxisValue is the accessor half of.
 *
 *   claude-code  the Shift+Tab ring IS the ladder, so every PermissionRung is a
 *                legal target (`bypass` additionally needs a bypass-enabling
 *                LAUNCH configuration, checked separately). `"default"` is NOT a
 *                rung: the epic's rule is "Default when permissionMode is unset:
 *                inject nothing", and claude's actual default is `manual`.
 *   codex        the collaboration 2-cycle: "default" | "plan" only. A ladder
 *                rung on codex is launch-flag territory (`-s` / `-a`).
 *
 * `"plan"` legitimately appears on BOTH lists and means different things on
 * each — the ladder rung on claude, the collaboration mode on codex. That is
 * exactly why the comparison always goes through permissionAxisValue.
 */
const permissionCycleTargets: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["plan", "manual", "acceptEdits", "auto", "bypass"],
  codex: ["default", "plan"],
};

/** The name of the axis setPermissionMode drives on `harness`, for messages. */
function permissionAxisName(harness: string): string {
  return harness === "codex" ? "collaboration" : "permissions ladder";
}

function permissionLegalTargets(harness: string): readonly string[] {
  return permissionCycleTargets[harness] ?? [];
}

function permissionTargetLegal(harness: string, target: string): boolean {
  return permissionLegalTargets(harness).includes(target);
}

/** ErrPermissionModeUnreachable carrying the concrete evidence. */
function permissionUnreachable(detail: string): Error {
  return wrap(
    "chat: setPermissionMode: " + detail,
    ErrPermissionModeUnreachable,
  );
}

/**
 * ErrPermissionModeStalled carrying the concrete evidence.
 *
 * `who` names the METHOD in the message. It defaults to setPermissionMode
 * because that is where every stall used to originate; refreshPermissionMode
 * (and the codex `/status` probe it shares with setPermissionMode) passes its
 * own name so a caller reading the message is not sent to the wrong method.
 */
function permissionStalled(detail: string, who = "setPermissionMode"): Error {
  return wrap(`chat: ${who}: ` + detail, ErrPermissionModeStalled);
}
// authGateStabilizeGap — how long the screen must stay on a logged-out /
// onboarding banner (matching authRequired but never reaching readyForInput)
// before awaitPromptReady short-circuits with ErrAuthRequired instead of blocking
// to the run deadline. The dwell distinguishes a persistent sign-in / onboarding
// wall (which never clears on its own) from a transient startup frame; a genuine
// composer is never gated because the readyForInput check wins first. (ms)
const authGateStabilizeGap = 2000;
// primeBoundGap — the overall wall-clock bound on the startup session-id prime,
// so Open can never hang on the /status scrape. (ms)
const primeBoundGap = 800;

/**
 * How the startup session-id prime ended. Named at module level so the guarded
 * setPrimeOutcome can take it as a parameter type.
 */
type PrimeOutcome =
  | "captured"
  | "too_narrow"
  | "not_written"
  | "written_uncaptured"
  | "persist_failed";

/**
 * How ONE codex `/status` probe ended — probeCodexStatus's return, deliberately
 * spelled in primeOutcome's vocabulary rather than paralleling it:
 *
 *   "done"                the caller's success predicate went true in time.
 *   "too_narrow"          the CONFIGURED width is below CODEX_STATUS_MIN_COLS,
 *                         so the box would wrap and the row scrapes fail closed.
 *                         NOTHING was written.
 *   "not_written"         the composer never reached a ready prompt inside the
 *                         bound. NOTHING was written.
 *   "written_uncaptured"  the burst went out (once, or twice with the halfway
 *                         resend) and the predicate never went true.
 *   "unsupported"         the adapter has no primeSessionIDKeys capability, so
 *                         there is no `/status` writer at all.
 */
type CodexProbeOutcome =
  "done" | "too_narrow" | "not_written" | "written_uncaptured" | "unsupported";
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A size-1 coalesced wake signal — the Go `chan struct{}` of capacity 1. */
class Signal {
  private pending = false;
  private waiter: (() => void) | null = null;
  signal(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
      return;
    }
    this.pending = true;
  }
  receive(): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  /** Non-blocking drain — true if a signal was pending (the select default). */
  tryReceive(): boolean {
    if (this.pending) {
      this.pending = false;
      return true;
    }
    return false;
  }
}

/** A buffered chat-event channel: emit drops when full; receive/tryReceive read. */
class EventBus {
  private readonly buf: ConversationEvent[] = [];
  private readonly recvWaiters: ((r: {
    value?: ConversationEvent;
    ok: boolean;
  }) => void)[] = [];
  private _closed = false;
  constructor(private readonly cap: number) {}

  /** Non-blocking push; drops the event when the buffer is full (Go's emit). */
  emit(ev: ConversationEvent): void {
    if (this._closed) return;
    const w = this.recvWaiters.shift();
    if (w) {
      w({ value: ev, ok: true });
      return;
    }
    if (this.buf.length >= this.cap) return;
    this.buf.push(ev);
  }

  /** Synchronous, non-blocking receive — the Go `select { case <-ch: default }`. */
  tryReceive(): { value?: ConversationEvent; ok: boolean } {
    if (this.buf.length > 0) return { value: this.buf.shift(), ok: true };
    return { value: undefined, ok: false };
  }

  receive(): Promise<{ value?: ConversationEvent; ok: boolean }> {
    if (this.buf.length > 0)
      return Promise.resolve({ value: this.buf.shift(), ok: true });
    if (this._closed) return Promise.resolve({ value: undefined, ok: false });
    return new Promise((resolve) => this.recvWaiters.push(resolve));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const w of this.recvWaiters.splice(0))
      w({ value: undefined, ok: false });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConversationEvent> {
    for (;;) {
      const { value, ok } = await this.receive();
      if (!ok) return;
      yield value!;
    }
  }
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

export class Conversation {
  opts: Options;
  store!: Store;
  adapter!: Adapter;
  sess?: WrapperSession;
  screen!: Screen;
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
  private finalObservation: { retryAfter: number; sawAPIError: boolean } = {
    retryAfter: 0,
    sawAPIError: false,
  };

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
  private primeOutcome?: PrimeOutcome;

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
  private primeModeReading?: PermissionModeReading;

  eventCh: EventBus;

  currentTurn: Turn | null = null;
  endMarkerSeen = false;
  /** Rendered screen at the moment send() submitted the in-flight prompt. */
  private sentScreenText = "";
  /** Raw prompt text of the in-flight send (transcript swallow-override proof). */
  private sentPromptText = "";
  /**
   * Transcript turn count captured just before the in-flight submit, or null
   * when unknown. The swallow-override proof only accepts a prompt match at an
   * index ≥ this watermark, so an identical prompt earlier in a resumed rollout
   * can never count as proof of the CURRENT turn (turnsFromEvents carries no
   * turn boundaries). Computed only for transcript-override-eligible adapters.
   */
  private sentTranscriptWatermark: number | null = null;
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

  currentInput: TurnsInputRequest | null = null;
  inputSurfaced = false;

  writeStdin?: (p: Uint8Array) => void;

  private closedFlag = false;
  private closedResolve!: () => void;
  private readonly closedPromise: Promise<void>;
  private closeDone = false;

  constructor(init: ConversationInit = {}) {
    this.opts = {
      harness: "",
      binaryPath: "",
      store: undefined as unknown as Store,
      ...init.opts,
    };
    if (init.store) this.store = init.store;
    if (init.adapter) this.adapter = init.adapter;
    if (init.sess) this.sess = init.sess;
    this.screen = init.screen ?? (undefined as unknown as Screen);
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
      new EventBus(
        this.opts.eventBuffer && this.opts.eventBuffer > 0
          ? this.opts.eventBuffer
          : 32,
      );
    this.currentTurn = init.currentTurn ?? null;
    this.markerArmCh = init.markerArmCh ?? new Signal();
    this.inputStateCh = init.inputStateCh ?? new Signal();
    this.hookDrainCh = init.hookDrainCh ?? new Signal();
    this.writeStdin = init.writeStdin;
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
    if (init.closed) {
      this.closedFlag = true;
      this.closedResolve();
    }
  }

  // ── Public surface ───────────────────────────────────────────────────────

  /** The chat-level session ID. */
  sessionID(): string {
    return this.session.id;
  }

  /** The per-harness turns adapter. */
  getAdapter(): Adapter {
    return this.adapter;
  }

  /** A coherent point-in-time view of the rendered terminal. */
  screenSnapshot(): Snapshot {
    return this.screen.snapshot();
  }

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
  permissionMode(snap?: Snapshot): PermissionModeReading {
    const s = snap ?? this.screenSnapshot();
    // `requested` is filled on EVERY reading, independent of `source`, and is
    // never an input to the source derivation.
    const rawReq = this.opts.permissionMode ?? "";
    const requestedRaw = rawReq === "" ? undefined : rawReq;
    // Normalized on the way in: without this a session launched with the native
    // spelling `bypassPermissions` would report requested "bypassPermissions"
    // against observed "bypass", and a caller diffing the two gets a false drift
    // alarm. An off-ladder value (e.g. `dontAsk`) yields undefined, keeping the
    // verbatim spelling in requestedRaw.
    const requested = requestedRaw
      ? normalizePermissionRung(requestedRaw, this.opts.harness)
      : undefined;

    if (this.opts.harness === "codex") {
      const cached = this.primeModeReading;
      if (cached) return { ...cached, requested, requestedRaw };
      return {
        requested,
        requestedRaw,
        observed: "unknown",
        collaboration: "unknown",
        source: this.codexUnobservedSource(),
        generation: s.generation,
        observedAt: new Date(),
      };
    }

    const screen = parsePermissionMode(s.text, this.opts.harness);
    if (!screen) {
      // No reader for this harness (pi / opencode / generic / "").
      return {
        requested,
        requestedRaw,
        observed: "unknown",
        source: "launch",
        generation: s.generation,
        observedAt: new Date(),
      };
    }
    return {
      ...screen,
      requested,
      requestedRaw,
      generation: s.generation,
      observedAt: new Date(),
    };
  }

  /** The channel of turn-state transitions (async-iterable). */
  events(): EventBus {
    return this.eventCh;
  }

  /** Block until granted the exclusive control token. FIFO. */
  acquireControl(ctx: Context): Promise<() => void> {
    return this.queue.acquire(ctx);
  }

  /** Terminate the harness, release the writer lock, stop the watcher. */
  async close(ctx?: Context): Promise<void> {
    if (this.closeDone) return;
    this.closeDone = true;
    this.closedFlag = true;
    this.closedResolve();
    this.queue.close();
    if (this.releaseWriter) this.releaseWriter();
    // Reap the hook drain BEFORE stopping the harness/watcher: close() runs a
    // final flush drain (catching a Stop/idle hook that landed after the last
    // wake) and then reaps the spool dir. Managed settings.json blocks are left
    // installed (idempotent, re-ensured each session) — removal is explicit only.
    if (this.hookDrain) this.hookDrain.close();
    // Final liveness sample, mirroring Go's one last onAct(sess.Snapshot()) when
    // the session stops (pkg/harness/run.go). It MUST be taken BEFORE
    // this.sess.stop() below — stop tears the session state down, so a sample
    // taken afterwards would be post-mortem. Setting closedResolve() above has
    // already unblocked the activityObserver loop, so it exits without taking an
    // extra post-stop sample.
    if (this.opts.onActivity && this.sess)
      this.opts.onActivity(this.sess.snapshot());
    if (this.sess) await this.sess.stop(ctx);
    if (this.watcher) this.watcher.close();
  }

  isClosed(): boolean {
    return this.closedFlag;
  }

  // ── Send / Quit ──────────────────────────────────────────────────────────

  /** Transmit a user message; record the user turn and a pending assistant turn. */
  async send(ctx: Context, text: string): Promise<string> {
    if (this.closedFlag) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.currentTurn !== null) throw ErrTurnInFlight;

    try {
      await this.waitReadyForSend(ctx);
    } catch (err) {
      // The harness is stuck on a logged-out / onboarding screen and will never
      // reach a ready prompt. Record a terminal assistant turn carrying the
      // canonical ReasonAuthRequired instead of hanging to the deadline, so the
      // onboarding case surfaces through the same events()/turn.reason channel as
      // the completion- and error-path cases. Returns the assistant turn id so the
      // runTurn driver observes the emitted terminal turn rather than a bare throw.
      if (isSentinel(err, ErrAuthRequired)) {
        return await this.emitAuthRequiredTurn(text);
      }
      throw err;
    }

    const now = new Date();
    const userTurn: Turn = {
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

    const assistantTurn: Turn = {
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
    } catch (err) {
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

  // emitAuthRequiredTurn records and emits a terminal assistant turn carrying
  // ReasonAuthRequired, for the case where the harness never reaches a ready
  // prompt because it is sitting in a logged-out / onboarding screen (detected by
  // waitReadyForSend). It mirrors the normal send bookkeeping — a completed user
  // turn, then a terminal assistant turn — so consumers observe the auth signal
  // through the same events()/turn.reason channel as the completion- and
  // error-path cases. The prompt is NOT written to the harness (it would land in
  // the sign-in menu). Returns the assistant turn id; the runTurn driver reads the
  // emitted Errored turn and surfaces its reason.
  private async emitAuthRequiredTurn(text: string): Promise<string> {
    const now = new Date();
    const userTurn: Turn = {
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

    const assistantTurn: Turn = {
      id: newID(),
      sessionID: this.session.id,
      role: RoleAssistant,
      state: TurnStateErrored,
      text: "",
      reason: ReasonAuthRequired,
      startedAt: now,
      completedAt: now,
      httpCode: 0,
      retryAfter: 0,
    };
    await this.store.appendTurn(assistantTurn);
    this.emit({ type: EventTurn, turn: assistantTurn });
    return assistantTurn.id;
  }

  /** The underlying wrapper session, for callers reaching past the chat API. */
  wrapper(): WrapperSession | undefined {
    return this.sess;
  }

  /** Ask the harness to exit gracefully via its adapter-defined quit sequence. */
  async quit(ctx: Context): Promise<void> {
    if (this.closedFlag) throw ErrClosed;
    const seq = this.adapterQuitSequence();
    if (!seq || seq.length === 0) throw ErrQuitUnsupported;
    const release = await this.queue.acquire(ctx);
    try {
      this.writeKeys(seq);
    } finally {
      release();
    }
  }

  // ── Permission mode (write side) ─────────────────────────────────────────

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
  async setPermissionMode(
    ctx: Context,
    target: PermissionModeTarget,
  ): Promise<PermissionModeReading> {
    // Gates 1-4. Note the ORDER matters for the caller's diagnosis: "closed"
    // outranks "no token" outranks "busy" outranks "blocked on a prompt".
    if (this.closedFlag) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.currentTurn !== null) throw ErrTurnInFlight;
    this.throwIfPermissionInputPending();

    const harness = this.opts.harness;

    // Capability probe. A harness with no cycle keystroke has no switch to
    // throw at all — a static property of the ADAPTER, distinct from a target
    // that is merely unreachable from here.
    const seq = this.adapterPermissionCycleKeys();
    if (!seq || seq.length === 0) throw ErrPermissionModeUnsupported;

    if (!permissionTargetLegal(harness, target)) {
      throw permissionUnreachable(
        `target ${JSON.stringify(target)} is not on the axis ` +
          `setPermissionMode drives for harness ${JSON.stringify(harness)} ` +
          `(${permissionAxisName(harness)}); reachable targets are ` +
          `${permissionLegalTargets(harness).join(" | ")}. ` +
          `Anything else is launch-flag territory — relaunch with the ` +
          `permissionMode option (or the harness's own permission flags).`,
      );
    }

    // The `bypass` fast-fail. A LAUNCH-CONFIGURATION fact: it reads the
    // structured Options.permissionMode knob AND argv, because Options carries
    // knobs that never appear in `args` (the same precedent as effort/model,
    // translated to argv inside the wrapper). A session opened with
    // `{ permissionMode: "bypass" }` and no raw `args` has an EMPTY opts.args
    // and an args-only predicate would wrongly reject it — on precisely the
    // sessions where bypass IS reachable. opts.args is not the launched argv
    // anyway (chat prepends a session-control prefix at launch). Being a launch
    // fact, it also stays correct across Reopen.
    if (target === PermissionModeBypass && !this.bypassEnabledAtLaunch()) {
      throw permissionUnreachable(
        `bypass is not enabled for this session: neither the permissionMode ` +
          `option nor args carry a bypass-enabling launch flag, so the rung is ` +
          `not on this session's Shift+Tab ring and no keystroke path can ` +
          `reach it. Relaunch with permissionMode "bypass" (or ` +
          `--permission-mode bypassPermissions / --dangerously-skip-permissions ` +
          `in args).`,
      );
    }

    // Gate 5. Rather than writing blind into a startup interstitial, an approval
    // dialog or a repainting composer, wait for a ready prompt under the
    // existing helper — which also throws ErrInputPending / ErrClosed / ctx.err
    // on its own terms.
    const { ctx: dctx, cancel } = Context.withCancel(ctx);
    try {
      const overall = new Promise<void>((resolve) => {
        void dctx.done().then(resolve);
      });
      if (!readyForInput(harness, this.screen.snapshot().text)) {
        // ErrClosed and ErrInputPending are this method's OWN vocabulary and
        // pass straight through; a bare ctx.err() is not — the ctx bound is
        // documented as ErrPermissionModeStalled wherever it fires, and this is
        // one of the places it can. Zero keystrokes either way.
        const w = await this.awaitPromptReadyUntil(ctx, overall).catch(
          (err: unknown) => {
            if (isSentinel(err, ErrClosed) || isSentinel(err, ErrInputPending))
              throw err;
            if (ctx.isDone()) return "deadline" as const;
            throw err;
          },
        );
        if (w === "deadline") {
          throw permissionStalled(
            `the harness never reached a ready prompt before the deadline; ` +
              `no cycle keystroke was written`,
          );
        }
      }

      // Gate 6, second half: the START value must be on-axis. A session launched
      // e.g. `--permission-mode dontAsk` (valid, flag-only, NOT on the ring)
      // reads `unknown` + a non-empty `raw`, so `start` is not a comparable
      // value and lap detection could never close — refuse, ZERO keystrokes.
      //
      // On codex the entry value comes from an internal `/status` probe, NOT
      // from the prime-time cache: that cache is unbounded-stale (and
      // `not_primed` outright on a resumed session), and there is no footer fast
      // path — 102 reads `collaboration` from the positive
      // `│ Collaboration mode: … │` row only, and footer-ABSENCE is
      // corroboration, never a conclusion. Trusting the cache here is exactly
      // the silent-wrong-mode window this method exists to close: a session
      // already in Default would be pressed into Plan and back.
      const entry =
        harness === "codex"
          ? await this.confirmCodexCollaboration(
              dctx,
              "setPermissionMode",
              null,
            )
          : await this.settlePermissionAxis(dctx, harness, null, null);
      if (!entry) {
        throw permissionStalled(
          `could not read the permission axis before pressing anything ` +
            `(source ${this.permissionMode().source}); no cycle keystroke was ` +
            `written`,
        );
      }
      const start = this.permissionAxisValue(harness, entry);

      // No-op. Returns BEFORE any write and without touching the queue beyond
      // the held() precondition — this is what makes the method idempotent.
      if (start === target) return entry;

      let reading = entry;
      const seen: string[] = [start];
      for (let press = 1; press <= permissionCycleMaxPresses; press++) {
        // Re-checked before EVERY press, not only at entry: a dialog can appear
        // mid-traversal (see the docstring's bypass-acceptance case).
        this.throwIfPermissionInputPending();
        const before = this.permissionAxisValue(harness, reading);
        // The overall ctx bound, checked BEFORE spending a press: a deadline
        // that fired mid-settle must not buy one more keystroke.
        if (dctx.isDone()) {
          throw permissionStalled(
            `the deadline fired after ${String(press - 1)} press(es) without ` +
              `reaching ${JSON.stringify(target)}; last observed ` +
              `${JSON.stringify(before)} on the ${permissionAxisName(harness)} ` +
              `axis`,
          );
        }
        const press1 = (): void => {
          this.writeKeys(seq);
        };
        // codex confirms with a FRESH `/status` probe after the press (the box
        // already on screen is the PREVIOUS probe's, and nothing repaints the
        // collaboration row on its own); claude re-reads its continuously
        // repainted footer. Both refuse a value equal to `before`.
        const settled =
          harness === "codex"
            ? await this.confirmCodexCollaboration(
                dctx,
                "setPermissionMode",
                before,
                press1,
              )
            : await this.settlePermissionAxis(dctx, harness, before, press1);
        // Re-checked after EVERY settle too, so a dialog that landed on the
        // final frame is reported as a pending prompt rather than as a stall.
        this.throwIfPermissionInputPending();
        if (!settled) {
          // The axis never changed inside the settle bound: the press DID NOT
          // TAKE (a PTY/render stall, or the captured byte sequence is wrong for
          // this build). Distinct from "changed, but not to the target", which
          // is normal and continues the ring below.
          throw permissionStalled(
            dctx.isDone()
              ? `the deadline fired during press ${String(press)} without ` +
                  `reaching ${JSON.stringify(target)}; last observed ` +
                  `${JSON.stringify(before)} on the ` +
                  `${permissionAxisName(harness)} axis`
              : `the permission axis did not change after press ` +
                  `${String(press)} (still ${JSON.stringify(before)} on the ` +
                  `${permissionAxisName(harness)} axis)`,
          );
        }
        reading = settled;
        const now = this.permissionAxisValue(harness, reading);
        if (!seen.includes(now)) seen.push(now);
        if (now === target) return reading;
        if (now === start) {
          throw permissionUnreachable(
            `the ${permissionAxisName(harness)} ring lapped back to ` +
              `${JSON.stringify(start)} after ${String(press)} press(es) ` +
              `without ` +
              `reaching ${JSON.stringify(target)}; values observed during the ` +
              `lap: ${seen.map((v) => JSON.stringify(v)).join(" -> ")}`,
          );
        }
      }
      throw permissionStalled(
        `gave up after the ${String(permissionCycleMaxPresses)}-press backstop ` +
          `without ` +
          `reaching ${JSON.stringify(target)}; last observed ` +
          `${JSON.stringify(this.permissionAxisValue(harness, reading))} on the ` +
          `${permissionAxisName(harness)} axis`,
      );
    } finally {
      cancel();
    }
  }

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
  private permissionAxisValue(
    harness: string,
    reading: PermissionModeReading,
  ): string {
    switch (harness) {
      case "claude-code":
        return reading.observed;
      case "codex":
        return reading.collaboration ?? "unknown";
      default:
        return "unknown";
    }
  }

  /**
   * The adapter's permission-mode cycle keystroke, or null.
   *
   * A verbatim copy of adapterQuitSequence's shape, and consumed the same way
   * quit() consumes it for ErrQuitUnsupported. The `permissionCycleKeys?()`
   * declaration in src/chat/deps.ts is DOCUMENTATION of the optional-capability
   * set, not compile-time checking — this runtime `typeof … === "function"`
   * probe plus the turns-layer contract test are the only real guards.
   */
  private adapterPermissionCycleKeys(): Uint8Array | null {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.permissionCycleKeys === "function") {
      return (a.permissionCycleKeys as () => Uint8Array)();
    }
    return null;
  }

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
  private bypassEnabledAtLaunch(): boolean {
    return (
      effectiveLaunchRung(
        this.opts.harness,
        this.opts.args ?? [],
        this.opts.permissionMode ?? "",
      ) === PermissionModeBypass
    );
  }

  /**
   * The STRICT pending-input refusal, carrying the pending request's `kind`.
   *
   * Deliberately `currentInput !== null` rather than inputAwaitingClient(): see
   * setPermissionMode's docstring for why, and for the permanent-failure case it
   * implies. The message names the kind and the escape hatch because to a caller
   * a permanent ErrInputPending otherwise looks like a hang.
   */
  private throwIfPermissionInputPending(): void {
    const req = this.currentInput;
    if (req === null) return;
    throw wrap(
      `chat: setPermissionMode refuses while an interactive prompt is pending ` +
        `(kind ${JSON.stringify(req.kind)}: ${JSON.stringify(req.prompt)}). ` +
        `Read it with pendingInput() and clear it with answer(); ` +
        `setPermissionMode never writes around a pending prompt.`,
      ErrInputPending,
    );
  }

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
  private permissionReadingError(
    harness: string,
    reading: PermissionModeReading,
  ): Error | null {
    if (this.permissionAxisValue(harness, reading) !== "unknown") return null;
    switch (reading.source) {
      case "no_footer":
        return null;
      case "unparsed_footer":
        return permissionStalled(
          `the permission footer is painted but did not parse ` +
            `(source ${reading.source}, raw ${JSON.stringify(reading.raw ?? "")})`,
        );
      case "too_narrow":
      case "not_primed":
      case "not_written":
      case "written_uncaptured":
        return permissionStalled(
          `the permission reading was never legibly captured ` +
            `(source ${reading.source})`,
        );
      default:
        // A legible read that landed OFF the ladder: "somewhere the ladder
        // can't name", not "we couldn't see".
        if (reading.raw !== undefined && reading.raw !== "") {
          return permissionUnreachable(
            `the session's current mode is off the ${permissionAxisName(harness)} ` +
              `axis: ${JSON.stringify(reading.raw)} names no rung on the ` +
              `Shift+Tab ring, so no keystroke path can leave it. Relaunch with ` +
              `a ring mode (or the harness's own permission flags).`,
          );
        }
        return null;
    }
  }

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
  private async settlePermissionAxis(
    ctx: Context,
    harness: string,
    before: string | null,
    write: (() => void) | null,
  ): Promise<PermissionModeReading | null> {
    const [notify, unsubscribe] = this.screen.subscribe();
    let gap: { promise: Promise<void>; cancel: () => void } | null = null;
    const never = new Promise<void>(() => {});
    try {
      if (write) write();
      // The gap is armed IMMEDIATELY, before any candidate exists, and it is the
      // ONLY bound on the "nothing happened at all" case: a press that does not
      // take (a dead PTY, or a byte sequence this build does not understand)
      // produces no render, so there is no notification to wake on and ctx may
      // carry no deadline. It is re-armed below whenever a NEW candidate
      // appears, so each candidate gets its own full quiescent window — but NOT
      // on every render, or a screen repainting the OLD value forever (a
      // spinner) would keep the loop alive past any bound.
      gap = sleep(this.permissionSettleDur());
      let cand: { value: string; generation: number } | null = null;
      let candReading: PermissionModeReading | null = null;
      for (;;) {
        // Check-before-wait, then re-check on every render. ONE snapshot per
        // iteration: permissionMode(snap?) takes the optional snapshot precisely
        // so the caller and the reading share a frame.
        const snap = this.screen.snapshot();
        const reading = this.permissionMode(snap);
        const err = this.permissionReadingError(harness, reading);
        if (err) throw err;
        const value = this.permissionAxisValue(harness, reading);
        if (value !== "unknown" && value !== before) {
          if (before === null) return reading; // entry read: no stability needed
          if (
            cand &&
            cand.value === value &&
            cand.generation !== snap.generation
          )
            return reading; // two distinct generations agree -> stable
          if (!cand || cand.value !== value) {
            cand = { value, generation: snap.generation };
            candReading = reading;
            // The quiescent bound starts when a candidate first appears; a
            // second render resolves it through the generation rule instead.
            gap?.cancel();
            gap = sleep(this.permissionSettleDur());
          }
        }

        const which = await Promise.race([
          ctx.done().then(() => "ctx" as const),
          this.closedPromise.then(() => "closed" as const),
          notify
            .receive()
            .then((r) => (r.ok ? ("changed" as const) : ("closed" as const))),
          (gap ? gap.promise : never).then(() => "gap" as const),
        ]);
        if (which === "ctx") {
          // The OVERALL ctx deadline. A candidate that never got its second
          // frame is still an honest advance OBSERVED BEFORE the deadline, so
          // hand it back rather than discard the evidence; the caller re-checks
          // ctx before pressing again, so this can never spend a press past the
          // deadline. No candidate => null, which the caller turns into Stalled.
          return candReading;
        }
        if (which === "closed") throw ErrClosed;
        if (which === "gap") return candReading;
        // "changed": a fresh render landed — re-read from its snapshot.
        this.throwIfPermissionInputPending();
      }
    } finally {
      gap?.cancel();
      unsubscribe();
    }
  }

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
  async refreshPermissionMode(ctx: Context): Promise<PermissionModeReading> {
    if (this.closedFlag) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.currentTurn !== null) throw ErrTurnInFlight;
    this.throwIfPermissionInputPending();
    if (this.opts.harness !== "codex") return this.permissionMode();

    const { ctx: dctx, cancel } = Context.withCancel(ctx);
    try {
      const r = await this.confirmCodexCollaboration(
        dctx,
        "refreshPermissionMode",
        null,
      );
      if (!r) {
        throw permissionStalled(
          `the codex /status box never rendered a legible ` +
            `\`Collaboration mode:\` row inside the probe bound ` +
            `(source ${this.permissionMode().source}); the cached reading is ` +
            `unchanged`,
          "refreshPermissionMode",
        );
      }
      return r;
    } finally {
      cancel();
    }
  }

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
  private async confirmCodexCollaboration(
    ctx: Context,
    who: string,
    before: string | null,
    write: (() => void) | null = null,
  ): Promise<PermissionModeReading | null> {
    if (write) write();
    let outcome: CodexProbeOutcome;
    try {
      outcome = await this.probeCodexStatus(ctx, this.primeBoundDur(), () =>
        this.refreshModeFromScreen(before),
      );
    } catch (err: unknown) {
      if (isSentinel(err, ErrClosed) || isSentinel(err, ErrInputPending))
        throw err;
      if (ctx.isDone()) return null;
      throw err;
    }
    switch (outcome) {
      case "done":
        // permissionMode() re-reads the field the probe just wrote, so the
        // returned reading carries `requested`/`requestedRaw` like any other.
        return this.permissionMode();
      case "written_uncaptured":
        return null;
      case "too_narrow":
        throw permissionStalled(
          `the configured width (${String(this.opts.cols ?? 0)} cols) is below ` +
            `CODEX_STATUS_MIN_COLS (${String(codex.CODEX_STATUS_MIN_COLS)}), so ` +
            `the /status box would wrap and its rows fail closed; nothing was ` +
            `written`,
          who,
        );
      case "not_written":
        throw permissionStalled(
          `the composer never reached a ready prompt, so the /status probe was ` +
            `never written`,
          who,
        );
      default:
        // No primeSessionIDKeys capability: there is no /status writer at all.
        throw ErrPermissionModeUnsupported;
    }
  }

  // ── Interactive input ────────────────────────────────────────────────────

  /** Respond to the interactive prompt currently awaiting an answer. */
  async answer(
    _ctx: Context,
    requestID: string,
    ans: InputAnswer,
  ): Promise<void> {
    if (this.closedFlag) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    const req = this.currentInput;
    if (req === null) throw ErrNoInputPending;
    if (requestID !== "" && requestID !== req.id) throw ErrStaleInputRequest;
    await this.writeAnswer(req, ans);
  }

  /** Records a pending request and tries policy/handler resolution, else surfaces. */
  handleInputRequested(req: TurnsInputRequest | undefined): void {
    if (!req) return;
    this.currentInput = req;
    this.inputSurfaced = false;

    if (this.tryAutoDismissCodex(req)) return;
    if (this.tryResolveInput(req)) return;

    this.inputSurfaced = true;
    this.signalInputState();
    this.emit({ type: EventInputRequest, input: toClientInputRequest(req) });
  }

  handleInputResolved(_req: TurnsInputRequest | undefined): void {
    const had = this.currentInput;
    this.currentInput = null;
    this.inputSurfaced = false;
    this.signalInputState();
    if (had === null) return;
    this.emit({ type: EventInputResolved, input: toClientInputRequest(had) });
  }

  private signalInputState(): void {
    this.inputStateCh.signal();
  }

  /** A prompt is pending that no policy/handler is resolving. */
  inputAwaitingClient(): boolean {
    return this.currentInput !== null && this.inputSurfaced;
  }

  /**
   * The interactive prompt currently awaiting a client answer, or null. The
   * polling counterpart of the EventInputRequest event: a caller that missed
   * the event (attached late, single events() consumer elsewhere) can still
   * read the pending question and resolve it via answer().
   */
  pendingInput(): InputRequest | null {
    if (!this.inputAwaitingClient()) return null;
    return toClientInputRequest(this.currentInput!);
  }

  private writeKeys(p: Uint8Array): void {
    if (this.writeStdin) {
      this.writeStdin(p);
      return;
    }
    if (!this.sess) throw new Error("chat: no session to write to");
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
  private writeMessageAndSubmit(
    text: string,
    preWriteScreen: string,
    submitKey: Uint8Array,
    ctx?: Context,
  ): Promise<void> {
    if (!requiresPromptReadiness(this.opts.harness)) {
      this.writeKeys(concat(enc.encode(text), submitKey));
      return Promise.resolve();
    }
    this.writeKeys(enc.encode(text));
    return this.awaitComposerEcho(text, preWriteScreen, ctx).then(() => {
      this.writeKeys(submitKey);
    });
  }

  private echoBoundDur(): number {
    const configured =
      this.opts.echoBound && this.opts.echoBound > 0
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
  private async awaitComposerEcho(
    text: string,
    preWriteScreen: string,
    ctx?: Context,
  ): Promise<void> {
    const needle = (text.split("\n", 1)[0] ?? "")
      .trim()
      .slice(0, echoNeedleLen);
    const bound = this.echoBoundDur();
    const deadline = sleep(bound);
    const half = sleep(bound / 2);
    const never = new Promise<void>(() => {});
    let halfDone = false;
    const [notify, unsubscribe] = this.screen.subscribe();
    try {
      for (;;) {
        const cur = this.screen.snapshot().text;
        if (needle !== "" && cur.includes(needle)) return;
        if ((halfDone || needle === "") && cur !== preWriteScreen) return;
        const which = await Promise.race([
          this.closedPromise.then(() => "closed" as const),
          notify
            .receive()
            .then((r) => (r.ok ? ("changed" as const) : ("closed" as const))),
          (halfDone ? never : half.promise).then(() => "half" as const),
          deadline.promise.then(() => "deadline" as const),
          ctx
            ? ctx.done().then(() => "ctx" as const)
            : never.then(() => "ctx" as const),
        ]);
        if (which === "ctx")
          throw ctx?.err() ?? new Error("chat: context done");
        if (which === "closed" || which === "deadline") return;
        if (which === "half") halfDone = true;
      }
    } finally {
      deadline.cancel();
      half.cancel();
      unsubscribe();
    }
  }

  private tryAutoDismissCodex(req: TurnsInputRequest): boolean {
    if (this.opts.harness !== "codex" || this.opts.disableCodexAutoDismiss)
      return false;
    // The update menu is surfaced to the client by default so it can choose
    // Update / Skip; only auto-Skip it when the caller opted in. The other
    // interstitials (model migration, menu-less notice) carry no user choice
    // and stay auto-dismissed.
    if (
      req.kind === codex.KindUpdateNotice &&
      !this.opts.autoSkipCodexUpdateNotice
    )
      return false;
    const [keys, ok] = codex.AutoDismissKeys(req);
    if (!ok || !keys) return false;
    this.writeKeys(keys);
    return true;
  }

  private tryResolveInput(req: TurnsInputRequest): boolean {
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
          void this.writeAnswer(req, ans).catch(() => {});
          return true;
        } catch {
          // fall through to surface
        }
      }
    }
    return false;
  }

  private policyOption(req: TurnsInputRequest): TurnsInputOption | null {
    const d = resolvePolicy(this.opts.inputPolicy, req.kind);
    if (!d) return null;
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
  private writeAnswer(req: TurnsInputRequest, ans: InputAnswer): Promise<void> {
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
    const ids =
      ans.optionIDs && ans.optionIDs.length > 0
        ? ans.optionIDs
        : ans.optionID
          ? [ans.optionID]
          : [];
    if (req.multiSelect && req.submitKeys) {
      const chosen = ids.map((s) => findOption(req, s));
      if (ids.length === 0 || chosen.some((o) => o === null))
        throw ErrUnknownOption;
      for (const o of chosen) this.writeKeys(o!.keys);
      this.writeKeys(req.submitKeys);
      return Promise.resolve();
    }
    if (ids.length > 1) throw ErrNotMultiSelect;
    const opt = findOption(req, ids[0] ?? "");
    if (!opt) throw ErrUnknownOption;
    this.writeKeys(opt.keys);
    return Promise.resolve();
  }

  // ── Watcher pump & turn-state machine ────────────────────────────────────

  private async consumeWatcher(): Promise<void> {
    try {
      for await (const ev of this.watcher!.events()) {
        await this.handleTurnsEvent(ev);
      }
    } finally {
      // The event loop is done only after pump 1 processed the TERMINAL event
      // (watcher.events() returns done from pumpDone()), so this is the correct
      // post-terminal seam to snapshot the full run-level observation — not
      // watcher.close(), which never joins pump 1.
      this.finalObservation = this.watcher!.observation();
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
  observation(): { retryAfter: number; sawAPIError: boolean } {
    return this.finalObservation;
  }

  async handleTurnsEvent(ev: TurnEvent): Promise<void> {
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
    if (turn === null) return;

    switch (ev.kind) {
      case TurnComplete:
        turn.state = TurnStateComplete;
        turn.completedAt = ev.at ?? new Date();
        turn.reason = ev.reason;
        if (ev.snap) {
          turn.text = this.assistantText(ev.snap);
          // A "completed" turn whose reply is really a usage-limit wall, or that
          // yielded no real reply on a logged-out / not-onboarded screen, is not a
          // success — relabel it (usage-limit wins; its wall IS a non-empty reply,
          // so authRelabel's empty-extraction gate would skip it).
          if (!this.usageLimitRelabel(turn, ev.snap))
            this.authRelabel(turn, ev.snap);
        }
        break;
      case Blocked:
        turn.state = TurnStateErrored;
        turn.completedAt = ev.at ?? new Date();
        turn.reason = ev.reason;
        turn.httpCode = ev.httpCode ?? 0;
        turn.retryAfter = ev.retryAfter ?? 0;
        break;
      case Errored: {
        turn.state = TurnStateErrored;
        turn.completedAt = ev.at ?? new Date();
        // A terminal error whose screen shows a logged-out / re-auth banner is not
        // a task failure — the harness CLI is logged out. Prefer the canonical,
        // machine-matchable auth reason over the generic one (e.g. "harness
        // exited"). Status-derived Errored events carry no snapshot (the wrapper-
        // status watcher pump stamps none), so fall back to the live screen, which
        // still shows the banner after the harness exits.
        const authText = ev.snap?.text ?? this.screen?.snapshot().text;
        turn.reason =
          authText !== undefined && authRequired(this.opts.harness, authText)
            ? ReasonAuthRequired
            : ev.reason;
        turn.httpCode = ev.httpCode ?? 0;
        turn.retryAfter = ev.retryAfter ?? 0;
        break;
      }
      case ToolCall:
        this.currentTurn = turn;
        return;
      default:
        this.currentTurn = turn;
        return;
    }

    try {
      await this.store.updateTurn(turn);
    } catch (err) {
      this.emit({ type: EventTurn, turn: { ...turn }, err });
      return;
    }
    this.emit({ type: EventTurn, turn: { ...turn } });
  }

  private idleGapDur(): number {
    return this.opts.idleGap && this.opts.idleGap > 0
      ? this.opts.idleGap
      : idleCompletionGap;
  }

  private markerGapDur(): number {
    return this.opts.markerGap && this.opts.markerGap > 0
      ? this.opts.markerGap
      : markerConfirmGap;
  }

  private permissionSettleDur(): number {
    return this.opts.permissionSettle && this.opts.permissionSettle > 0
      ? this.opts.permissionSettle
      : permissionSettleGap;
  }

  private async idleCompletionWatcher(): Promise<void> {
    if (!requiresPromptReadiness(this.opts.harness)) return;
    const [notify, unsubscribe] = this.screen.subscribe();
    try {
      let notifyP = notify.receive();
      let markerP = this.markerArmCh.receive();
      let gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur();
      let timer = sleep(gap);
      for (;;) {
        if (this.closedFlag) return;
        const which = await Promise.race([
          notifyP.then((r) =>
            r.ok ? ("notify" as const) : ("closed" as const),
          ),
          markerP.then(() => "marker" as const),
          this.closedPromise.then(() => "closed" as const),
          timer.promise.then(() => "timer" as const),
        ]);
        if (which === "closed") return;
        if (which === "notify") notifyP = notify.receive();
        if (which === "marker") markerP = this.markerArmCh.receive();
        if (which === "timer") await this.maybeIdleComplete();
        // Re-arm on every event with the (possibly shortened) gap.
        timer.cancel();
        gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur();
        timer = sleep(gap);
      }
    } finally {
      unsubscribe();
    }
  }

  private activityIntervalDur(): number {
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
  private async activityObserver(): Promise<void> {
    if (this.opts.onActivity === undefined) return;
    const interval = this.activityIntervalDur();
    for (;;) {
      if (this.closedFlag) return;
      const timer = sleep(interval);
      const which = await Promise.race([
        this.closedPromise.then(() => "closed" as const),
        timer.promise.then(() => "timer" as const),
      ]);
      timer.cancel();
      if (which === "closed") return;
      if (this.closedFlag) return;
      if (this.sess) this.opts.onActivity(this.sess.snapshot());
    }
  }

  async maybeIdleComplete(): Promise<void> {
    const turn = this.currentTurn;
    if (turn === null) return;
    if (this.inputAwaitingClient()) return;
    const marker = this.endMarkerSeen;
    const snap = this.screen.snapshot();
    if (!marker && !readyForInput(this.opts.harness, snap.text)) return;
    if (this.adapterBusy(snap)) return;
    const gap = marker ? this.markerGapDur() : this.idleGapDur();
    if (Date.now() - turn.startedAt.getTime() < gap) return;

    if (this.currentTurn === null || this.currentTurn.id !== turn.id) return;

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
      if (this.closedFlag) return;
      if (this.currentTurn === null || this.currentTurn.id !== turn.id) return;
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
      } else {
        turn.state = TurnStateErrored;
        // No assistant output was recoverable. If the settled screen shows a
        // logged-out / re-auth banner, the turn didn't fail on its merits — the
        // harness is logged out; record the canonical auth reason instead of the
        // generic "prompt not accepted" one.
        turn.reason = authRequired(this.opts.harness, snap.text)
          ? ReasonAuthRequired
          : this.opts.harness +
            ": prompt not accepted / no assistant output" +
            (diag !== "" ? "; " + diag : "");
      }
      try {
        await this.store.updateTurn(turn);
      } catch (err) {
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
    // The claude-code false-success lands HERE: a logged-out turn ends on a
    // "✻ … for 0s" marker (marker === true) and would otherwise complete with the
    // raw banner screen as its reply. Relabel it ReasonAuthRequired when no real
    // reply was extracted — or ReasonUsageLimited when the "reply" is a usage-limit
    // wall (which, being a non-empty extraction, would slip past authRelabel).
    if (!this.usageLimitRelabel(turn, snap)) this.authRelabel(turn, snap);
    try {
      await this.store.updateTurn(turn);
    } catch (err) {
      this.emit({ type: EventTurn, turn: { ...turn }, err });
      return;
    }
    this.emit({ type: EventTurn, turn: { ...turn } });
  }

  // ── Session-id capture ───────────────────────────────────────────────────

  async maybeExtractSessionID(): Promise<void> {
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
        const done = await this.captureAndPersistSessionID(
          id,
          /* replace */ true,
        );
        if (done) this.harnessSessionIDProvisional = false;
      }
      return;
    }
    if (this.session.harnessSessionID !== "") return;
    // First-write path: allow the disk fallback ONLY when the prime wrote
    // `/status` but the box never yielded an id (`written_uncaptured`). In the
    // common case the scrape works and the fallback is never consulted, so
    // race-freedom is preserved. See extractSessionID / primeOutcome.
    const [id, ok] = this.extractSessionID(
      this.primeOutcome === "written_uncaptured",
    );
    if (!ok) return;
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
  private async captureAndPersistSessionID(
    id: string,
    replace: boolean,
  ): Promise<boolean> {
    if (id === "") return false;
    const current = this.session.harnessSessionID;
    if (replace) {
      if (id === current) return false;
    } else if (current !== "") {
      return false;
    }
    try {
      await this.store.updateSession({ ...this.session, harnessSessionID: id });
    } catch {
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
  private async captureFromScreen(): Promise<boolean> {
    if (this.session.harnessSessionID !== "") return true;
    // Called inside the prime poll loop: the disk fallback is premature during
    // priming (the whole point of the poll is to render and scrape the box), and
    // primeOutcome is not yet finalized. Scrape only.
    const [id, ok] = this.extractSessionID(false);
    if (!ok) return false;
    return this.captureAndPersistSessionID(id, /* replace */ false);
  }

  private primeBoundDur(): number {
    return this.opts.primeBound && this.opts.primeBound > 0
      ? this.opts.primeBound
      : primeBoundGap;
  }

  // ── Permission-mode capture (codex /status box) ──────────────────────────

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
  private setPrimeOutcome(o: PrimeOutcome): void {
    if (this.primeOutcome === "captured") return;
    this.primeOutcome = o;
  }

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
  private captureModeFromScreen(): boolean {
    if (this.primeModeReading) return true;
    const snap = this.screenSnapshot();
    const r = parsePermissionMode(snap.text, this.opts.harness);
    if (!r || r.raw === undefined) return false;
    this.primeModeReading = {
      ...r,
      generation: snap.generation,
      observedAt: new Date(),
    };
    return true;
  }

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
   *  - `before` filters out a STALE box. On the confirm probe the box already on
   *    screen is the previous probe's, painted before the cycle keystroke; a
   *    probe that accepted it would read the pre-press value and declare the
   *    press dead. Non-null `before` therefore rejects an equal value; null (the
   *    entry probe / an explicit refresh) accepts the first positive row.
   *
   * It writes the SAME private field the primer writes, which is what keeps
   * refreshPermissionMode and the pure GET route from disagreeing.
   */
  private refreshModeFromScreen(before: string | null): boolean {
    const snap = this.screenSnapshot();
    const r = parsePermissionMode(snap.text, this.opts.harness);
    const collab = r?.collaboration;
    if (!r || collab === undefined || collab === "unknown") return false;
    if (before !== null && collab === before) return false;
    this.primeModeReading = {
      ...r,
      generation: snap.generation,
      observedAt: new Date(),
    };
    return true;
  }

  /**
   * Whether the CONFIGURED width is too narrow for the `/status` box to render
   * unwrapped — the write gate both `/status` writers share.
   *
   * `this.opts.cols` is the configured width, NOT a live measurement: that is
   * precisely what `source: "too_narrow"` means. Below the documented minimum
   * the box wraps, the row-anchored scrapes fail closed, and writing would only
   * spend a burst to learn nothing.
   */
  private codexStatusTooNarrow(): boolean {
    const cols = this.opts.cols && this.opts.cols > 0 ? this.opts.cols : 120;
    return cols < codex.CODEX_STATUS_MIN_COLS;
  }

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
   *     "finished" means.
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
  private async probeCodexStatus(
    ctx: Context,
    bound: number,
    done: () => boolean | Promise<boolean>,
  ): Promise<CodexProbeOutcome> {
    const a = this.adapter as unknown as {
      primeSessionIDKeys?: () => Uint8Array;
    };
    if (typeof a.primeSessionIDKeys !== "function") return "unsupported";
    if (this.codexStatusTooNarrow()) return "too_narrow";

    const deadline = sleep(bound);
    const half = sleep(bound / 2);
    const never = new Promise<void>(() => {});
    try {
      // Wait past interstitials/auto-dismiss for a ready prompt rather than
      // writing blind into one.
      if (
        (await this.awaitPromptReadyUntil(ctx, deadline.promise)) !== "ready"
      ) {
        return "not_written";
      }

      // A writeKeys throw is fatal (writer/PTY dead) and propagates.
      this.writeKeys(a.primeSessionIDKeys());

      // Check-before-wait (a render landing right after the write, before any
      // subscription delivery, is otherwise missed), then poll under ONE
      // subscription until done() or the deadline.
      const [notify, unsubscribe] = this.screen.subscribe();
      try {
        if (await done()) return "done";
        let resent = false;
        for (;;) {
          const which = await Promise.race([
            ctx.done().then(() => "ctx" as const),
            this.closedPromise.then(() => "closed" as const),
            notify
              .receive()
              .then((r) => (r.ok ? ("changed" as const) : ("closed" as const))),
            (resent ? never : half.promise).then(() => "half" as const),
            deadline.promise.then(() => "deadline" as const),
          ]);
          if (which === "ctx") throw ctx.err();
          if (which === "closed") throw ErrClosed;
          if (which === "changed") {
            if (await done()) return "done";
            continue;
          }
          if (which === "half") {
            // One-shot resend at the halfway mark: only when something is still
            // missing (the loop has already returned when done() went true) and
            // the composer prompt is ready. The latch is consumed either way, so
            // the MAXIMUM is two bursts per probe.
            resent = true;
            if (readyForInput(this.opts.harness, this.screen.snapshot().text)) {
              this.writeKeys(a.primeSessionIDKeys());
            }
            continue;
          }
          return "written_uncaptured"; // deadline
        }
      } finally {
        unsubscribe();
      }
    } finally {
      deadline.cancel();
      half.cancel();
    }
  }

  /**
   * Why the codex `/status` box was never observed — a TOTAL function of the
   * prime outcome, reusing primeOutcome's vocabulary rather than paralleling it.
   *
   * `"written_uncaptured"` is literally accurate for the `"captured"` row: the
   * id landed (possibly from a `codex resume` hint that carries no box at all),
   * `/status` WAS written, and the box was NOT captured.
   */
  private codexUnobservedSource(): PermissionModeSource {
    switch (this.primeOutcome) {
      case "captured":
      case "written_uncaptured":
      case "persist_failed":
        return "written_uncaptured";
      case "not_written":
        return "not_written";
      case "too_narrow":
        return "too_narrow";
      default:
        // Unset: the prime never ran — resume/Reopen, or the id was already
        // seeded. NEVER reachable on claude, whose primeSessionID returns before
        // any outcome is recorded (no primeSessionIDKeys); reporting "we never
        // primed" there would misdescribe an unpainted footer.
        return "not_primed";
    }
  }

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
  private async primeSessionID(ctx: Context): Promise<void> {
    const a = this.adapter as unknown as {
      primeSessionIDKeys?: () => Uint8Array;
    };
    if (typeof a.primeSessionIDKeys !== "function") return;
    if (this.session.harnessSessionID !== "") return;

    // The row-anchored /status scrape needs the box to render unwrapped; below
    // the documented minimum width the box wraps and the scrape can't parse it,
    // so skip the write entirely and let the /quit hint backstop. Checked HERE,
    // before the acquire, so a too-narrow open never touches the queue.
    if (this.codexStatusTooNarrow()) {
      this.setPrimeOutcome("too_narrow");
      return;
    }

    // The acquire is the primer's, NOT the shared probe's: refreshPermissionMode
    // reaches probeCodexStatus already HOLDING the token. See probeCodexStatus.
    const release = await this.queue.acquire(ctx);
    try {
      // The two halves are DECOUPLED on purpose, and NEITHER is short-circuited:
      // extractSessionID tries the `codex resume <uuid>` hint FIRST, and a frame
      // that yields the id that way carries no /status box at all — so exiting
      // the instant the id lands would leave the permission box permanently
      // unobserved. Cost: on an open where the id lands early and the box never
      // renders, Open blocks the full prime bound (≤ 800 ms by default).
      const outcome = await this.probeCodexStatus(
        ctx,
        this.primeBoundDur(),
        async () => {
          const gotID = await this.captureFromScreen();
          if (gotID) this.setPrimeOutcome("captured");
          const gotBox = this.captureModeFromScreen();
          return gotID && gotBox;
        },
      );
      switch (outcome) {
        case "done":
        case "too_narrow": // pre-checked above; unreachable here
        case "unsupported": // pre-checked above; unreachable here
          return;
        case "not_written":
          this.setPrimeOutcome("not_written");
          return;
        default: {
          // Distinguish a persist failure (box rendered + parsed, but the store
          // rejected, so the id is still empty) from a plain poll miss. Scrape
          // ONLY (allowDiskFallback=false): this discriminator must reflect the
          // screen scrape alone. If the disk fallback ran here, a matching
          // rollout already on disk would set `parsed = true` even though the box
          // never rendered — misclassifying `written_uncaptured` as
          // `persist_failed`, which is NOT in the firing gate set, so the
          // fallback would then never arm on the next TurnComplete (silently
          // disabling itself).
          //
          // Guarded: reaching the deadline with the id ALREADY captured (the box
          // never rendered) must not downgrade "captured" — that value keeps the
          // disk fallback disarmed on the next TurnComplete.
          const [, parsed] = this.extractSessionID(false);
          this.setPrimeOutcome(
            parsed && this.session.harnessSessionID === ""
              ? "persist_failed"
              : "written_uncaptured",
          );
          return;
        }
      }
    } catch (err) {
      // Capture misses are non-fatal; lifecycle/IO failures propagate. A
      // client-facing prompt we can't auto-dismiss is a miss, not a failure —
      // and it can ONLY come from the probe's readiness wait, which runs strictly
      // BEFORE the write, so nothing was written.
      if (err === ErrInputPending) {
        this.setPrimeOutcome("not_written");
        return;
      }
      throw err;
    } finally {
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
  private extractSessionID(allowDiskFallback: boolean): [string, boolean] {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.extractSessionID === "function") {
      const [id, ok] = (
        a.extractSessionID as (s: Snapshot) => [string, boolean]
      )(this.screen.snapshot());
      if (ok) return [id, true];
    }
    if (allowDiskFallback && typeof a.locateSessionID === "function") {
      const [id, ok] = (a.locateSessionID as (w: string) => [string, boolean])(
        this.opts.workingDir ?? "",
      );
      if (ok) return [id, true];
    }
    return ["", false];
  }

  async captureRawSessionID(line: string): Promise<void> {
    if (this.session.harnessSessionID !== "") return;
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.extractSessionIDFromLine !== "function") return;
    const [id, ok] = (
      a.extractSessionIDFromLine as (l: string) => [string, boolean]
    )(line);
    if (!ok) return;
    // Route through the shared persist-before-set path (first-write mode) so raw
    // line capture gets the same correctness as the screen-scrape path.
    await this.captureAndPersistSessionID(id, /* replace */ false);
  }

  // ── History ──────────────────────────────────────────────────────────────

  async history(): Promise<Turn[]> {
    const [out] = await this.historyWithSource();
    return out;
  }

  async historyWithSource(): Promise<[Turn[], HistorySource]> {
    const sessionCopy = { ...this.session };
    const a = this.adapter as unknown as Record<string, unknown>;
    const hasReader = typeof a.readTranscript === "function";
    if (!hasReader || sessionCopy.harnessSessionID === "") {
      const out = await this.store.listTurns(sessionCopy.id);
      return [out, HistorySourceStore];
    }
    let tturns: { role: string; text: string; timestamp?: Date }[];
    try {
      tturns = (
        a.readTranscript as (
          id: string,
          wd: string,
        ) => { role: string; text: string; timestamp?: Date }[]
      )(sessionCopy.harnessSessionID, this.opts.workingDir ?? "");
    } catch (err) {
      // A not-yet-flushed (or lost) transcript degrades to store history,
      // favoring availability. Real reader failures (parse/permission/etc.)
      // rethrow so they are not silently masked.
      if (
        isSentinel(err, ErrSessionNotFound) ||
        isSentinel(err, ErrEmptySessionID)
      ) {
        const out = await this.store.listTurns(sessionCopy.id);
        return [out, HistorySourceStore];
      }
      throw err;
    }
    const out: Turn[] = tturns.map((tt) => ({
      id: "",
      sessionID: sessionCopy.id,
      role: tt.role as Turn["role"],
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
  private assistantText(snap: Snapshot, wholeScreenFallback = true): string {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.extractMessage === "function") {
      const [msg, ok] = (
        a.extractMessage as (s: Snapshot) => [string, boolean]
      )(snap);
      if (ok) return msg;
      if (!wholeScreenFallback) return "";
    }
    return snap.text;
  }

  // cleanAssistantText is the adapter's extracted assistant reply with NO
  // whole-screen fallback: "" when the adapter has no extractor or finds no reply.
  // It is the "did this turn actually produce a reply?" signal used by authRelabel.
  // (Distinct from assistantText(snap, false), which still returns the whole screen
  // for an adapter that has no extractMessage at all — e.g. codex.)
  private cleanAssistantText(snap: Snapshot): string {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.extractMessage === "function") {
      const [msg, ok] = (
        a.extractMessage as (s: Snapshot) => [string, boolean]
      )(snap);
      if (ok) return msg;
    }
    return "";
  }

  // authRelabel converts a turn that "completed" but produced NO real assistant
  // reply, on a settled screen showing a logged-out / not-onboarded banner, into
  // the canonical ReasonAuthRequired failure. Without it a logged-out claude-code
  // turn — which ends on a "✻ … for 0s" end-of-turn thinking marker, not an error
  // — is persisted as a SUCCESS with the raw banner screen as its "reply" (the
  // false-success bug). Gated on an EMPTY clean extraction, so a genuine reply
  // (which produces a "⏺" bullet) is never touched even if it mentions "/login".
  // Returns true if it relabeled the turn.
  private authRelabel(turn: Turn, snap: Snapshot): boolean {
    if (this.cleanAssistantText(snap).trim() !== "") return false;
    if (!authRequired(this.opts.harness, snap.text)) return false;
    turn.state = TurnStateErrored;
    turn.reason = ReasonAuthRequired;
    turn.text = "";
    return true;
  }

  // usageLimitRelabel converts a turn whose extracted "reply" is in fact the CLI's
  // usage/session-limit WALL — "You've hit your session limit · resets 10:20pm …",
  // which claude-code paints as an assistant bubble — into a ReasonUsageLimited
  // failure with the wall line as the reason detail and the reply cleared. Without
  // it the wall is persisted as a SUCCESS whose text is the wall, and a downstream
  // validator (e.g. a plan reviewer) rejects it as a bad reply, retries, and trips
  // the orchestrator's runaway guard so a TRANSIENT quota outage BLOCKS the ticket.
  //
  // Distinct from authRelabel, which is gated on an EMPTY extraction: the wall IS
  // the (non-empty) extracted reply. Precise because the match is anchored to the
  // CLI's exact wall phrasing, which a genuine model reply does not emit — so the
  // extracted reply is probed first, with the whole screen as a fallback only when
  // nothing was extracted. Returns true if it relabeled the turn.
  private usageLimitRelabel(turn: Turn, snap: Snapshot): boolean {
    const reply = this.cleanAssistantText(snap);
    const probe = reply.trim() !== "" ? reply : snap.text;
    const message = usageLimitMessage(this.opts.harness, probe);
    if (message === null) return false;
    turn.state = TurnStateErrored;
    turn.reason = `${ReasonUsageLimited} (${message})`;
    turn.text = "";
    return true;
  }

  private adapterPromptNotAccepted(snap: Snapshot): boolean {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.promptNotAccepted === "function") {
      return (a.promptNotAccepted as (s: Snapshot, sent: string) => boolean)(
        snap,
        this.sentScreenText,
      );
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
  private transcriptOverrideEligible(): boolean {
    // Runs on EVERY send (unlike the other structural probes, which only run
    // once a watcher is pumping), so it must tolerate adapter-less test
    // Conversations constructed directly from ConversationInit.
    const a = this.adapter as unknown as Record<string, unknown> | undefined;
    return (
      a !== undefined &&
      typeof a.readTranscript === "function" &&
      typeof a.extractMessage !== "function"
    );
  }

  private readTranscriptTurns(id: string): { role: string; text: string }[] {
    const a = this.adapter as unknown as Record<string, unknown>;
    return (
      a.readTranscript as (
        id: string,
        wd: string,
      ) => { role: string; text: string }[]
    )(id, this.opts.workingDir ?? "");
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
  private captureTranscriptWatermark(): number | null {
    if (!this.transcriptOverrideEligible()) return null;
    if (this.session.harnessSessionID === "") return 0;
    try {
      return this.readTranscriptTurns(this.session.harnessSessionID).length;
    } catch (err) {
      if (
        isSentinel(err, ErrSessionNotFound) ||
        isSentinel(err, ErrEmptySessionID)
      )
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
  private async transcriptProofOfCurrentTurn(): Promise<
    [{ text: string } | null, string]
  > {
    if (!this.transcriptOverrideEligible()) return [null, ""];
    if (this.session.harnessSessionID === "") return [null, ""];
    const watermark = this.sentTranscriptWatermark;
    if (watermark === null)
      return [null, "pre-send transcript watermark unavailable"];

    const first = this.tryTranscriptProof(watermark);
    if (first.proof !== null || !first.retryable)
      return [first.proof, first.diag];
    const timer = sleep(transcriptFlushRetryGap);
    try {
      await Promise.race([timer.promise, this.closedPromise]);
    } finally {
      timer.cancel();
    }
    if (this.closedFlag) return [null, first.diag];
    const second = this.tryTranscriptProof(watermark);
    return [second.proof, second.diag];
  }

  /** One synchronous proof attempt; retryable marks flush-lag-shaped misses. */
  private tryTranscriptProof(watermark: number): {
    proof: { text: string } | null;
    diag: string;
    retryable: boolean;
  } {
    let turns: { role: string; text: string }[];
    try {
      turns = this.readTranscriptTurns(this.session.harnessSessionID);
    } catch (err) {
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
      if (t.role !== RoleUser) continue;
      if (stripIDEContextTags(t.text) === want) {
        match = i;
        break;
      }
    }
    if (match < 0) return { proof: null, diag: "", retryable: true };
    const replies: string[] = [];
    for (let i = match + 1; i < turns.length; i++) {
      const t = turns[i];
      if (t.role === RoleUser) break; // stop: a later turn must not contaminate
      if (t.role !== RoleAssistant) continue; // skip RoleSystem between the two
      if (t.text.trim() === "") continue;
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

  private adapterBusy(snap: Snapshot): boolean {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.busy === "function") {
      return (a.busy as (s: Snapshot) => boolean)(snap);
    }
    return false;
  }

  private adapterQuitSequence(): Uint8Array | null {
    const a = this.adapter as unknown as Record<string, unknown>;
    if (typeof a.quitSequence === "function") {
      return (a.quitSequence as () => Uint8Array)();
    }
    return null;
  }

  private adapterRawSessionID(): boolean {
    const a = this.adapter as unknown as Record<string, unknown>;
    return typeof a.extractSessionIDFromLine === "function";
  }

  private async waitReadyForSend(ctx: Context): Promise<void> {
    if (this.inputAwaitingClient()) throw ErrInputPending;
    if (!requiresPromptReadiness(this.opts.harness)) return;
    return this.awaitPromptReady(ctx);
  }

  /**
   * Blocks until the composer prompt is ready for a message. Owns its screen
   * subscription in a try/finally so it always unsubscribes. Throws ctx.err() on
   * cancellation, ErrClosed on close, ErrInputPending on a client-facing prompt.
   * Extracted verbatim from waitReadyForSend's loop.
   */
  private async awaitPromptReady(ctx: Context): Promise<void> {
    const [notify, unsubscribe] = this.screen.subscribe();

    // Stabilize timer for a soft logged-out BANNER on a not-ready screen (rare on
    // the send path). An onboarding WALL is handled separately, immediately (see
    // check). The race is rebuilt each iteration, so referencing the current
    // `armedAuth` is enough: a never-resolving promise when disarmed, the timeout
    // promise when armed.
    const never = new Promise<void>(() => {});
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    let armedAuth: Promise<void> = never;
    const disarmAuth = (): void => {
      if (authTimer !== undefined) {
        clearTimeout(authTimer);
        authTimer = undefined;
      }
      armedAuth = never;
    };
    // check classifies the current screen. An onboarding WALL (sign-in wizard /
    // device-code / login-method screen) fires NOW: it never becomes ready, and
    // it can appear for a single frame before the CLI advances its own login flow
    // past it — a dwell would miss it. A softer logged-out banner arms the
    // debounce timer instead. readyForInput wins first, so a real composer (even
    // with a stale banner scrolled above) is never auth-gated.
    const check = (): "ready" | "wall" | "wait" => {
      const txt = this.screen.snapshot().text;
      if (readyForInput(this.opts.harness, txt)) return "ready";
      if (onboardingWall(this.opts.harness, txt)) return "wall";
      if (authRequired(this.opts.harness, txt)) {
        if (authTimer === undefined) {
          armedAuth = new Promise<void>((res) => {
            authTimer = setTimeout(res, authGateStabilizeGap);
          });
        }
      } else {
        disarmAuth();
      }
      return "wait";
    };

    try {
      const first = check();
      if (first === "ready") return;
      if (first === "wall") throw ErrAuthRequired;
      for (;;) {
        const which = await Promise.race([
          ctx.done().then(() => "ctx" as const),
          this.closedPromise.then(() => "closed" as const),
          this.inputStateCh.receive().then(() => "input" as const),
          notify
            .receive()
            .then((r) =>
              r.ok ? ("notify" as const) : ("notifyClosed" as const),
            ),
          armedAuth.then(() => "auth" as const),
        ]);
        if (which === "ctx") throw ctx.err();
        if (which === "closed") throw ErrClosed;
        if (which === "notifyClosed") throw ErrClosed;
        if (which === "auth") {
          // Re-confirm against the live screen before committing: a frame may
          // have changed it without a wake we processed, so never short-circuit
          // on a stale banner.
          const txt = this.screen.snapshot().text;
          if (
            !readyForInput(this.opts.harness, txt) &&
            authRequired(this.opts.harness, txt)
          )
            throw ErrAuthRequired;
          disarmAuth();
          continue;
        }
        if (this.inputAwaitingClient()) throw ErrInputPending;
        const c = check();
        if (c === "ready") return;
        if (c === "wall") throw ErrAuthRequired;
      }
    } finally {
      disarmAuth();
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
  private async awaitPromptReadyUntil(
    ctx: Context,
    deadlinePromise: Promise<void>,
  ): Promise<"ready" | "deadline"> {
    const [notify, unsubscribe] = this.screen.subscribe();
    try {
      if (readyForInput(this.opts.harness, this.screen.snapshot().text))
        return "ready";
      for (;;) {
        const which = await Promise.race([
          ctx.done().then(() => "ctx" as const),
          this.closedPromise.then(() => "closed" as const),
          this.inputStateCh.receive().then(() => "input" as const),
          notify
            .receive()
            .then((r) =>
              r.ok ? ("notify" as const) : ("notifyClosed" as const),
            ),
          deadlinePromise.then(() => "deadline" as const),
        ]);
        if (which === "ctx") throw ctx.err();
        if (which === "closed") throw ErrClosed;
        if (which === "notifyClosed") throw ErrClosed;
        if (which === "deadline") return "deadline";
        if (this.inputAwaitingClient()) throw ErrInputPending;
        if (readyForInput(this.opts.harness, this.screen.snapshot().text))
          return "ready";
      }
    } finally {
      unsubscribe();
    }
  }

  emit(ev: ConversationEvent): void {
    this.eventCh.emit(ev);
  }

  /** Internal: start the watcher + idle pumps. Used by Open. */
  startPumps(): void {
    void this.consumeWatcher();
    void this.idleCompletionWatcher();
    // Harness-independent periodic liveness ticker. Runs its OWN loop (a
    // cancellable sleep raced against close), inert unless onActivity is set.
    void this.activityObserver();
    // The hook drain runs its OWN loop (spool watch + bounded fallback timer),
    // deliberately NOT hung off consumeWatcher — so a SessionStart-before-any-
    // file-change or an idle-period Stop drains promptly regardless of turn
    // activity. Inert unless the run opted in and the adapter supports hooks.
    if (this.hookDrain) this.hookDrain.start();
  }
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timeout);
    },
  };
}

function resolvePolicy(
  p: InputPolicy | undefined,
  kind: string,
): Disposition | null {
  if (!p) return null;
  const d = p.byKind?.[kind];
  if (d?.kind) return d;
  if (p.default) return { kind: p.default };
  return null;
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
export function launchInputPolicy(
  opts: Pick<Options, "harness" | "permissionMode" | "inputPolicy">,
): InputPolicy | undefined {
  switch (normHarness(opts.harness)) {
    case "claude":
    case "claude-code":
      break;
    default:
      return opts.inputPolicy;
  }
  const mode = opts.permissionMode ?? "";
  if (mode !== PermissionModeBypass && mode !== ClaudeModeBypassPermissions) {
    return opts.inputPolicy;
  }
  if (resolvePolicy(opts.inputPolicy, "trust_prompt")) return opts.inputPolicy;
  return {
    ...opts.inputPolicy,
    byKind: {
      ...opts.inputPolicy?.byKind,
      trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
    },
  };
}

function toClientInputRequest(req: TurnsInputRequest): InputRequest {
  const out: InputRequest = { id: req.id, kind: req.kind, prompt: req.prompt };
  if (req.options && req.options.length > 0) {
    out.options = req.options.map((o) => ({
      id: o.id,
      alias: o.alias,
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
    }));
  }
  if (req.header !== undefined) out.header = req.header;
  if (req.multiSelect) out.multiSelect = true;
  return out;
}

function findOption(
  req: TurnsInputRequest,
  s: string,
): TurnsInputOption | null {
  if (s === "") return null;
  const ls = s.toLowerCase();
  for (const o of req.options ?? []) {
    if (
      o.id === s ||
      o.alias.toLowerCase() === ls ||
      o.label.toLowerCase() === ls
    )
      return o;
  }
  return null;
}

function findOptionByAlias(
  req: TurnsInputRequest,
  alias: string,
): TurnsInputOption | null {
  for (const o of req.options ?? []) {
    if (o.alias === alias) return o;
  }
  return null;
}

/** resolveAdapter maps a harness name to a concrete turns.Adapter. */
export function resolveAdapter(name: string): Adapter {
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
export async function Open(
  ctx: Context | undefined,
  opts: Options,
): Promise<Conversation> {
  if (!opts.harness || !opts.binaryPath) {
    throw wrapInvalid("Harness and BinaryPath are required");
  }
  if (!opts.store) {
    throw wrapInvalid("Store is required (pass newMemStore() for the default)");
  }
  const session: Session = {
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
async function openWithSession(
  ctx: Context | undefined,
  opts: Options,
  session: Session,
  persist: boolean,
): Promise<Conversation> {
  const cols = opts.cols && opts.cols > 0 ? opts.cols : 120;
  const rows = opts.rows && opts.rows > 0 ? opts.rows : 40;

  // The advanced/testing seam wins: a caller-supplied adapter drives Open
  // directly (used to exercise Stream mode with a fake interleaved adapter).
  const adapter: Adapter = opts.adapter ?? resolveAdapter(opts.harness);

  // Resolve resume args up front so an unsupported harness fails before launch.
  let resumeArgs: string[] = [];
  if (opts.resume) {
    const ra = adapterResumeArgs(adapter, opts.resume);
    if (ra === null) {
      throw wrap(
        `chat: harness ${opts.harness} cannot resume`,
        ErrResumeUnsupported,
      );
    }
    resumeArgs = ra;
  }

  // On the create path (NOT resuming), let the adapter mint its own session id
  // and the launch args that pin it, seeding harnessSessionID before persistence.
  let initArgs: string[] = [];
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
      throw wrapInvalid(
        `argument ${bad} conflicts with chat-managed session control; use Options.resume / Reopen`,
      );
    }
  }

  const scr = newScreen(cols, rows);

  const c = new Conversation({
    opts: { ...opts, cols, rows, inputPolicy: launchInputPolicy(opts) },
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
  const acquisitionMode = planAcquisition(
    opts.acquisitionMode ?? AcquisitionModeOff,
    {
      profile,
      haveSink,
      // Hooks side-channel delivery is a later subtask; not viable in A1, so the
      // Hooks rung falls back to Stream (when eligible) or Off.
      hooksViable: false,
    },
  );

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
  (
    adapter as unknown as {
      bindLaunchEnv?: (env: string[], workingDir: string) => void;
    }
  ).bindLaunchEnv?.(env, opts.workingDir ?? "");

  // Wire the HW_* hook env (spool dir, cwd, home, yield file) into the launch env
  // for Hooks mode, whenever a caller supplied a YieldControl handle, or when the
  // hook drain is active. The active drain's own spool dir wins so out-of-process
  // hook fires land where the drain reads (its ensureConfig already created it);
  // otherwise fall back to the raw opts.spoolDir (Hooks-mode/yield callers).
  const hookSpoolDir = c.hookDrain
    ? c.hookDrain.spoolDir()
    : (opts.spoolDir ?? "");
  const needHookEnv =
    !!opts.yieldControl ||
    acquisitionMode === AcquisitionModeHooks ||
    !!c.hookDrain;
  let launchEnv = needHookEnv
    ? hookEnv(
        env,
        hookSpoolDir,
        opts.workingDir ?? "",
        opts.yieldControl ?? null,
      )
    : env;
  // The out-of-process hook CLI keys its session-mismatch guard and config dir off
  // these; set them so a stray hook from an unrelated session is dropped and the
  // CLI resolves the same config dir the drain installed the managed block under.
  if (c.hookDrain) {
    launchEnv = [
      ...launchEnv,
      `${EnvConfigDir}=${c.hookDrain.hookContext().configDir}`,
      // Transition compat: also export the deprecated spelling so an older
      // installed meta-harness-hooks bin still resolves the config dir. Remove
      // in the next minor release together with EnvConfigDirDeprecated itself
      // and its docs row (docs/md/guides/hook-env.md).
      `${EnvConfigDirDeprecated}=${c.hookDrain.hookContext().configDir}`,
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
    permissionMode: opts.permissionMode,
    // The SINGLE durable onLine callback fans out to BOTH consumers. StreamTap
    // runs synchronously (emitting live events with the current — possibly empty
    // — session id); raw capture is async (it persists the record), so an early
    // stream event ships with an empty id and is BACKFILLED once capture lands.
    onLine: needsTap
      ? (line: string) => {
          streamTap.onLine(line);
          if (rawCapture) {
            void c
              .captureRawSessionID(line)
              .then(() => {
                streamTap.backfill();
              })
              .catch(() => {});
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

  if (persist) await opts.store.createSession({ ...c.session });

  c.watcher = Watch(
    sess as unknown as Parameters<typeof Watch>[0],
    scr,
    adapter,
  );
  c.startPumps();

  // Prime the harness session id before returning the handle (Codex /status
  // scrape). Suppressed on resume (the id is already seeded). A capture miss is
  // non-fatal; a fatal lifecycle/IO failure tears the half-built session down.
  if (!opts.resume) {
    try {
      await c["primeSessionID"](ctx ?? Context.background());
    } catch (err) {
      // ctx-less close awaits actual termination (Session.stop with the cancelled
      // Open ctx would return before the process exits and leak it).
      await c.close();
      throw err;
    }
  }

  return c;
}

/**
 * ReopenOptions configures Reopen. `harness` and `workingDir` are omitted because
 * they are derived from the stored Session; `resume` is omitted because it is
 * derived from the stored harnessSessionID. Every other launch knob (binaryPath,
 * env, args, effort, model, permissionMode, cols, rows, inputPolicy,
 * onInputRequest, …) must be supplied by the caller — the stored Session persists ONLY harness, workingDir,
 * and harnessSessionID, so it cannot reconstruct them.
 */
export type ReopenOptions = Omit<
  Options,
  "harness" | "workingDir" | "resume"
> & {
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
export async function Reopen(
  ctx: Context | undefined,
  opts: ReopenOptions,
): Promise<Conversation> {
  if (!opts.store) {
    throw wrapInvalid("Store is required (pass newMemStore() for the default)");
  }
  const stored = await opts.store.getSession(opts.sessionID);
  if (stored.harnessSessionID === "") {
    throw wrap(
      `chat: session ${opts.sessionID} has no harness session id`,
      ErrNoHarnessSession,
    );
  }
  const launch: Options = {
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
function adapterHookProvider(adapter: Adapter): HookProvider | null {
  const a = adapter as unknown as Record<string, unknown>;
  if (typeof a.hookProvider !== "function") return null;
  return (a.hookProvider as () => HookProvider)();
}

/** Structurally probes an adapter for SessionResumer; null when unsupported. */
function adapterResumeArgs(
  adapter: Adapter,
  harnessSessionID: string,
): string[] | null {
  const a = adapter as unknown as Record<string, unknown>;
  if (typeof a.resumeArgs !== "function") return null;
  return (a.resumeArgs as (id: string) => string[])(harnessSessionID);
}

/** Structurally probes an adapter for SessionInitializer; null when unsupported. */
function adapterInitSession(adapter: Adapter): [string[], string] | null {
  const a = adapter as unknown as Record<string, unknown>;
  if (typeof a.initSession !== "function") return null;
  return (a.initSession as () => [string[], string])();
}

/** Structurally probes an adapter for SessionControlFlags; [] when unsupported. */
function adapterSessionControlFlags(adapter: Adapter): string[] {
  const a = adapter as unknown as Record<string, unknown>;
  if (typeof a.sessionControlFlags !== "function") return [];
  return (a.sessionControlFlags as () => string[])();
}

/**
 * firstSessionControlConflict scans args (up to a bare "--" terminator) for the
 * first token that conflicts with a chat-managed session-control flag: an exact
 * match, or, for a long flag, the attached `--flag=value` form. Returns the
 * offending token or undefined.
 */
function firstSessionControlConflict(
  args: string[],
  banned: string[],
): string | undefined {
  const set = new Set(banned);
  const longFlags = banned.filter((f) => f.startsWith("--"));
  for (const tok of args) {
    if (tok === "--") break; // positionals follow; never flags
    if (set.has(tok)) return tok;
    for (const f of longFlags) {
      if (tok.startsWith(f + "=")) return tok;
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
export function adapterResumeForks(adapter: Adapter): boolean {
  const a = adapter as unknown as Record<string, unknown>;
  if (typeof a.resumeForksSessionID !== "function") return false;
  return (a.resumeForksSessionID as () => boolean)();
}

function wrapInvalid(msg: string): Error {
  return wrap(`chat: invalid options: ${msg}`, ErrInvalidOptions);
}

export { EventBus, Signal };
