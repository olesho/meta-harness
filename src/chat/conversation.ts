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

import { newScreen, type Screen, type Snapshot } from "../screen/index.ts"
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
  gemini,
  opencode,
  pi,
} from "../turns/index.ts"
import { start as wrapperStart, type Session as WrapperSession } from "../wrapper/index.ts"
import { Context, isSentinel, wrap } from "../internal/async/index.ts"
import { ErrEmptySessionID, ErrSessionNotFound } from "../transcript/errors.ts"
import type { Store } from "./store.ts"
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
  newID,
} from "./types.ts"
import {
  ErrInvalidOptions,
  ErrUnknownHarness,
  ErrNoControl,
  ErrTurnInFlight,
  ErrClosed,
  ErrInputPending,
  ErrNoInputPending,
  ErrStaleInputRequest,
  ErrUnknownOption,
  ErrQuitUnsupported,
  ErrResumeUnsupported,
  ErrNoHarnessSession,
} from "./errors.ts"
import { ControlQueue, newControlQueue } from "./control.ts"
import { submitKeyForHarness, requiresPromptReadiness, readyForInput } from "./ready.ts"
import { cleanHarnessEnv } from "./env.ts"

/** Options configures a single Conversation. Mirrors chat.Options. */
export interface Options {
  /** Per-harness adapter name. Required. */
  harness: string
  /** The harness executable. Required. */
  binaryPath: string
  args?: string[]
  /**
   * When set, resumes the named *harness* session id (not the chat session id):
   * the resolved adapter must implement SessionResumer, whose resumeArgs are
   * prepended to `args` at launch, and the new chat Session's harnessSessionID
   * is seeded with this value. Open throws ErrResumeUnsupported if the harness
   * cannot resume. Prefer Reopen to derive this from a stored Session.
   */
  resume?: string
  workingDir?: string
  env?: string[]
  effort?: string
  model?: string
  cols?: number
  rows?: number
  /** Backs the chat metadata. Required; pass newMemStore() for the default. */
  store: Store
  /** Sizes the events buffer. Defaults to 32. */
  eventBuffer?: number
  /** Pre-configures how blocking interactive prompts are resolved. */
  inputPolicy?: InputPolicy
  /** Turns off the built-in auto-dismissal of Codex startup interstitials. */
  disableCodexAutoDismiss?: boolean
  /** In-process resolver consulted when InputPolicy did not auto-answer. */
  onInputRequest?: (req: InputRequest) => [InputAnswer, boolean]
  /** Test-only idle-completion window override (ms). Zero = package default. */
  idleGap?: number
  /** Test-only marker-confirm window override (ms). Zero = package default. */
  markerGap?: number
  /** Test-only session-id prime deadline override (ms). Zero = package default. */
  primeBound?: number
}

const enc = new TextEncoder()

// idleCompletionGap — how long the screen must sit unchanged at the ready prompt
// before the idle fallback completes an in-flight turn. (ms)
const idleCompletionGap = 8000
// markerConfirmGap — the shorter quiet window used once an end-of-turn marker has
// been seen. (ms)
const markerConfirmGap = 2000
// primeBoundGap — the overall wall-clock bound on the startup session-id prime,
// so Open can never hang on the /status scrape. (ms)
const primeBoundGap = 800

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** A size-1 coalesced wake signal — the Go `chan struct{}` of capacity 1. */
class Signal {
  private pending = false
  private waiter: (() => void) | null = null
  signal(): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w()
      return
    }
    this.pending = true
  }
  receive(): Promise<void> {
    if (this.pending) {
      this.pending = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }
  /** Non-blocking drain — true if a signal was pending (the select default). */
  tryReceive(): boolean {
    if (this.pending) {
      this.pending = false
      return true
    }
    return false
  }
}

/** A buffered chat-event channel: emit drops when full; receive/tryReceive read. */
class EventBus {
  private readonly buf: ConversationEvent[] = []
  private readonly recvWaiters: Array<(r: { value?: ConversationEvent; ok: boolean }) => void> = []
  private _closed = false
  constructor(private readonly cap: number) {}

  /** Non-blocking push; drops the event when the buffer is full (Go's emit). */
  emit(ev: ConversationEvent): void {
    if (this._closed) return
    const w = this.recvWaiters.shift()
    if (w) {
      w({ value: ev, ok: true })
      return
    }
    if (this.buf.length >= this.cap) return
    this.buf.push(ev)
  }

  /** Synchronous, non-blocking receive — the Go `select { case <-ch: default }`. */
  tryReceive(): { value?: ConversationEvent; ok: boolean } {
    if (this.buf.length > 0) return { value: this.buf.shift(), ok: true }
    return { value: undefined, ok: false }
  }

  receive(): Promise<{ value?: ConversationEvent; ok: boolean }> {
    if (this.buf.length > 0) return Promise.resolve({ value: this.buf.shift(), ok: true })
    if (this._closed) return Promise.resolve({ value: undefined, ok: false })
    return new Promise((resolve) => this.recvWaiters.push(resolve))
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    for (const w of this.recvWaiters.splice(0)) w({ value: undefined, ok: false })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConversationEvent> {
    for (;;) {
      const { value, ok } = await this.receive()
      if (!ok) return
      yield value!
    }
  }
}

/** Fields a Conversation can be constructed with (the Go struct-literal shape). */
export interface ConversationInit {
  opts?: Partial<Options>
  store?: Store
  adapter?: Adapter
  sess?: WrapperSession
  screen?: Screen
  watcher?: Watcher
  queue?: ControlQueue
  session?: Session
  eventCh?: EventBus
  currentTurn?: Turn | null
  markerArmCh?: Signal
  inputStateCh?: Signal
  closed?: boolean
  /** Test injection: replaces sess.writeStdin for answer/quit keystrokes. */
  writeStdin?: (p: Uint8Array) => void
}

export class Conversation {
  opts: Options
  store!: Store
  adapter!: Adapter
  sess?: WrapperSession
  screen!: Screen
  watcher?: Watcher
  releaseWriter?: () => void
  queue: ControlQueue
  session: Session

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
  harnessSessionIDProvisional = false

  /**
   * Diagnostic outcome of the startup session-id prime (primeSessionID). Read by
   * tests via a structural escape; NOT a public accessor and NOT walked by the
   * contract golden (private instance field). Undefined when priming did not run
   * (resume, non-codex, id already set).
   */
  private primeOutcome?:
    | "captured"
    | "too_narrow"
    | "not_written"
    | "written_uncaptured"
    | "persist_failed"

  eventCh: EventBus

  currentTurn: Turn | null = null
  endMarkerSeen = false
  markerArmCh: Signal
  inputStateCh: Signal

  currentInput: TurnsInputRequest | null = null
  inputSurfaced = false

  writeStdin?: (p: Uint8Array) => void

  private closedFlag = false
  private closedResolve!: () => void
  private readonly closedPromise: Promise<void>
  private closeDone = false

  constructor(init: ConversationInit = {}) {
    this.opts = { harness: "", binaryPath: "", store: undefined as unknown as Store, ...init.opts } as Options
    if (init.store) this.store = init.store
    if (init.adapter) this.adapter = init.adapter
    if (init.sess) this.sess = init.sess
    this.screen = init.screen ?? (undefined as unknown as Screen)
    this.watcher = init.watcher
    this.queue = init.queue ?? newControlQueue()
    this.session = init.session ?? {
      id: "",
      harness: this.opts.harness,
      workingDir: this.opts.workingDir ?? "",
      createdAt: new Date(),
      harnessSessionID: "",
    }
    this.eventCh = init.eventCh ?? new EventBus(this.opts.eventBuffer && this.opts.eventBuffer > 0 ? this.opts.eventBuffer : 32)
    this.currentTurn = init.currentTurn ?? null
    this.markerArmCh = init.markerArmCh ?? new Signal()
    this.inputStateCh = init.inputStateCh ?? new Signal()
    this.writeStdin = init.writeStdin
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve
    })
    if (init.closed) {
      this.closedFlag = true
      this.closedResolve()
    }
  }

  // ── Public surface ───────────────────────────────────────────────────────

  /** The chat-level session ID. */
  sessionID(): string {
    return this.session.id
  }

  /** The per-harness turns adapter. */
  getAdapter(): Adapter {
    return this.adapter
  }

  /** A coherent point-in-time view of the rendered terminal. */
  screenSnapshot(): Snapshot {
    return this.screen.snapshot()
  }

  /** The channel of turn-state transitions (async-iterable). */
  events(): EventBus {
    return this.eventCh
  }

  /** Block until granted the exclusive control token. FIFO. */
  acquireControl(ctx: Context): Promise<() => void> {
    return this.queue.acquire(ctx)
  }

  /** Terminate the harness, release the writer lock, stop the watcher. */
  async close(ctx?: Context): Promise<void> {
    if (this.closeDone) return
    this.closeDone = true
    this.closedFlag = true
    this.closedResolve()
    this.queue.close()
    if (this.releaseWriter) this.releaseWriter()
    if (this.sess) await this.sess.stop(ctx)
    if (this.watcher) this.watcher.close()
  }

  isClosed(): boolean {
    return this.closedFlag
  }

  // ── Send / Quit ──────────────────────────────────────────────────────────

  /** Transmit a user message; record the user turn and a pending assistant turn. */
  async send(ctx: Context, text: string): Promise<string> {
    if (this.closedFlag) throw ErrClosed
    if (!this.queue.held()) throw ErrNoControl
    if (this.currentTurn !== null) throw ErrTurnInFlight

    await this.waitReadyForSend(ctx)

    const now = new Date()
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
    }
    await this.store.appendTurn(userTurn)
    this.emit({ type: EventTurn, turn: userTurn })

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
    }
    await this.store.appendTurn(assistantTurn)

    this.currentTurn = { ...assistantTurn }
    this.endMarkerSeen = false

    const submitKey = submitKeyForHarness(this.opts.harness, this.screen.snapshot().text)
    try {
      this.writeKeys(concat(enc.encode(text), submitKey))
    } catch (err) {
      this.currentTurn = null
      assistantTurn.state = TurnStateErrored
      assistantTurn.reason = "WriteStdin: " + String(err)
      assistantTurn.completedAt = new Date()
      await this.store.updateTurn(assistantTurn)
      this.emit({ type: EventTurn, turn: assistantTurn, err })
      throw err
    }

    this.emit({ type: EventTurn, turn: assistantTurn })
    return assistantTurn.id
  }

  /** The underlying wrapper session, for callers reaching past the chat API. */
  wrapper(): WrapperSession | undefined {
    return this.sess
  }

  /** Ask the harness to exit gracefully via its adapter-defined quit sequence. */
  async quit(ctx: Context): Promise<void> {
    if (this.closedFlag) throw ErrClosed
    const seq = this.adapterQuitSequence()
    if (!seq || seq.length === 0) throw ErrQuitUnsupported
    const release = await this.queue.acquire(ctx)
    try {
      this.writeKeys(seq)
    } finally {
      release()
    }
  }

  // ── Interactive input ────────────────────────────────────────────────────

  /** Respond to the interactive prompt currently awaiting an answer. */
  async answer(_ctx: Context, requestID: string, ans: InputAnswer): Promise<void> {
    if (this.closedFlag) throw ErrClosed
    if (!this.queue.held()) throw ErrNoControl
    const req = this.currentInput
    if (req === null) throw ErrNoInputPending
    if (requestID !== "" && requestID !== req.id) throw ErrStaleInputRequest
    this.writeAnswer(req, ans)
  }

  /** Records a pending request and tries policy/handler resolution, else surfaces. */
  handleInputRequested(req: TurnsInputRequest | undefined): void {
    if (!req) return
    this.currentInput = req
    this.inputSurfaced = false

    if (this.tryAutoDismissCodex(req)) return
    if (this.tryResolveInput(req)) return

    this.inputSurfaced = true
    this.signalInputState()
    this.emit({ type: EventInputRequest, input: toClientInputRequest(req) })
  }

  handleInputResolved(_req: TurnsInputRequest | undefined): void {
    const had = this.currentInput
    this.currentInput = null
    this.inputSurfaced = false
    this.signalInputState()
    if (had === null) return
    this.emit({ type: EventInputResolved, input: toClientInputRequest(had) })
  }

  private signalInputState(): void {
    this.inputStateCh.signal()
  }

  /** A prompt is pending that no policy/handler is resolving. */
  inputAwaitingClient(): boolean {
    return this.currentInput !== null && this.inputSurfaced
  }

  private writeKeys(p: Uint8Array): void {
    if (this.writeStdin) {
      this.writeStdin(p)
      return
    }
    if (!this.sess) throw new Error("chat: no session to write to")
    this.sess.writeStdin(p)
  }

  private tryAutoDismissCodex(req: TurnsInputRequest): boolean {
    if (this.opts.harness !== "codex" || this.opts.disableCodexAutoDismiss) return false
    const [keys, ok] = codex.AutoDismissKeys(req)
    if (!ok || !keys) return false
    this.writeKeys(keys)
    return true
  }

  private tryResolveInput(req: TurnsInputRequest): boolean {
    const opt = this.policyOption(req)
    if (opt) {
      this.writeKeys(opt.keys)
      return true
    }
    if (this.opts.onInputRequest) {
      const [ans, ok] = this.opts.onInputRequest(toClientInputRequest(req))
      if (ok) {
        try {
          this.writeAnswer(req, ans)
          return true
        } catch {
          // fall through to surface
        }
      }
    }
    return false
  }

  private policyOption(req: TurnsInputRequest): TurnsInputOption | null {
    const d = resolvePolicy(this.opts.inputPolicy, req.kind)
    if (!d) return null
    switch (d.kind) {
      case DispositionAnswer:
        return findOption(req, d.optionID ?? "")
      case DispositionDeny:
        return findOptionByAlias(req, "deny")
      default:
        return null
    }
  }

  private writeAnswer(req: TurnsInputRequest, ans: InputAnswer): void {
    const opts = req.options ?? []
    if (opts.length === 0) {
      const submit = submitKeyForHarness(this.opts.harness, this.screen.snapshot().text)
      this.writeKeys(concat(enc.encode(ans.text ?? ""), submit))
      return
    }
    const opt = findOption(req, ans.optionID ?? "")
    if (!opt) throw ErrUnknownOption
    this.writeKeys(opt.keys)
  }

  // ── Watcher pump & turn-state machine ────────────────────────────────────

  private async consumeWatcher(): Promise<void> {
    try {
      for await (const ev of this.watcher!.events()) {
        await this.handleTurnsEvent(ev)
      }
    } finally {
      this.eventCh.close()
    }
  }

  async handleTurnsEvent(ev: TurnEvent): Promise<void> {
    switch (ev.kind) {
      case InputRequested:
        this.handleInputRequested(ev.input)
        return
      case InputResolved:
        this.handleInputResolved(ev.input)
        return
    }

    if (ev.kind === TurnComplete) {
      await this.maybeExtractSessionID()

      if (this.opts.harness === "claude-code") {
        const pending = this.currentTurn !== null
        if (pending) {
          this.endMarkerSeen = true
          this.markerArmCh.signal()
          return
        }
      }
    }

    const turn = this.currentTurn
    this.currentTurn = null
    if (turn === null) return

    switch (ev.kind) {
      case TurnComplete:
        turn.state = TurnStateComplete
        turn.completedAt = ev.at ?? new Date()
        turn.reason = ev.reason
        if (ev.snap) turn.text = this.assistantText(ev.snap)
        break
      case Blocked:
      case Errored:
        turn.state = TurnStateErrored
        turn.completedAt = ev.at ?? new Date()
        turn.reason = ev.reason
        turn.httpCode = ev.httpCode ?? 0
        turn.retryAfter = ev.retryAfter ?? 0
        break
      case ToolCall:
        this.currentTurn = turn
        return
      default:
        this.currentTurn = turn
        return
    }

    try {
      await this.store.updateTurn(turn)
    } catch (err) {
      this.emit({ type: EventTurn, turn: { ...turn }, err })
      return
    }
    this.emit({ type: EventTurn, turn: { ...turn } })
  }

  private idleGapDur(): number {
    return this.opts.idleGap && this.opts.idleGap > 0 ? this.opts.idleGap : idleCompletionGap
  }

  private markerGapDur(): number {
    return this.opts.markerGap && this.opts.markerGap > 0 ? this.opts.markerGap : markerConfirmGap
  }

  private async idleCompletionWatcher(): Promise<void> {
    if (!requiresPromptReadiness(this.opts.harness)) return
    const [notify, unsubscribe] = this.screen.subscribe()
    try {
      let notifyP = notify.receive()
      let markerP = this.markerArmCh.receive()
      let gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur()
      let timer = sleep(gap)
      for (;;) {
        if (this.closedFlag) return
        const which = await Promise.race([
          notifyP.then((r) => r.ok ? ("notify" as const) : ("closed" as const)),
          markerP.then(() => "marker" as const),
          this.closedPromise.then(() => "closed" as const),
          timer.promise.then(() => "timer" as const),
        ])
        if (which === "closed") return
        if (which === "notify") notifyP = notify.receive()
        if (which === "marker") markerP = this.markerArmCh.receive()
        if (which === "timer") await this.maybeIdleComplete()
        // Re-arm on every event with the (possibly shortened) gap.
        timer.cancel()
        gap = this.endMarkerSeen ? this.markerGapDur() : this.idleGapDur()
        timer = sleep(gap)
      }
    } finally {
      unsubscribe()
    }
  }

  async maybeIdleComplete(): Promise<void> {
    const turn = this.currentTurn
    if (turn === null) return
    if (this.inputAwaitingClient()) return
    const marker = this.endMarkerSeen
    const snap = this.screen.snapshot()
    if (!marker && !readyForInput(this.opts.harness, snap.text)) return
    if (this.adapterBusy(snap)) return
    const gap = marker ? this.markerGapDur() : this.idleGapDur()
    if (Date.now() - turn.startedAt.getTime() < gap) return

    if (this.currentTurn === null || this.currentTurn.id !== turn.id) return
    this.currentTurn = null
    this.endMarkerSeen = false

    await this.maybeExtractSessionID()

    turn.state = TurnStateComplete
    turn.completedAt = new Date()
    turn.reason = marker
      ? this.opts.harness + ": end-of-turn marker confirmed at a settled prompt"
      : this.opts.harness + ": idle-completion fallback (end-of-turn marker not observed)"
    turn.text = this.assistantText(snap)
    try {
      await this.store.updateTurn(turn)
    } catch (err) {
      this.emit({ type: EventTurn, turn: { ...turn }, err })
      return
    }
    this.emit({ type: EventTurn, turn: { ...turn } })
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
      const [id, ok] = this.extractSessionID()
      if (ok && id !== "" && id !== this.session.harnessSessionID) {
        // Persist-before-set: on a persist failure keep the latch armed and the
        // old id so the next TurnComplete retries.
        const done = await this.captureAndPersistSessionID(id, /* replace */ true)
        if (done) this.harnessSessionIDProvisional = false
      }
      return
    }
    if (this.session.harnessSessionID !== "") return
    const [id, ok] = this.extractSessionID()
    if (!ok) return
    await this.captureAndPersistSessionID(id, /* replace */ false)
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
  private async captureAndPersistSessionID(id: string, replace: boolean): Promise<boolean> {
    if (id === "") return false
    const current = this.session.harnessSessionID
    if (replace) {
      if (id === current) return false
    } else if (current !== "") {
      return false
    }
    try {
      await this.store.updateSession({ ...this.session, harnessSessionID: id })
    } catch {
      return false // leave in-memory unchanged; retry on the next turn
    }
    this.session.harnessSessionID = id
    return true
  }

  /** Extract the id from the current screen and first-write it. True once set. */
  private async captureFromScreen(): Promise<boolean> {
    if (this.session.harnessSessionID !== "") return true
    const [id, ok] = this.extractSessionID()
    if (!ok) return false
    return this.captureAndPersistSessionID(id, /* replace */ false)
  }

  private primeBoundDur(): number {
    return this.opts.primeBound && this.opts.primeBound > 0
      ? this.opts.primeBound
      : primeBoundGap
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
  private async primeSessionID(ctx: Context): Promise<void> {
    const a = this.adapter as unknown as { primeSessionIDKeys?: () => Uint8Array }
    if (typeof a.primeSessionIDKeys !== "function") return
    if (this.session.harnessSessionID !== "") return

    // The row-anchored /status scrape needs the box to render unwrapped; below
    // the documented minimum width the box wraps and the scrape can't parse it,
    // so skip the write entirely and let the /quit hint backstop.
    const cols = this.opts.cols && this.opts.cols > 0 ? this.opts.cols : 120
    if (cols < codex.CODEX_STATUS_MIN_COLS) {
      this.primeOutcome = "too_narrow"
      return
    }

    const release = await this.queue.acquire(ctx)
    const bound = this.primeBoundDur()
    const deadline = sleep(bound)
    const half = sleep(bound / 2)
    const never = new Promise<void>(() => {})
    let wrote = false
    try {
      // Step 3: wait past interstitials/auto-dismiss for a ready prompt.
      const w0 = await this.awaitPromptReadyUntil(ctx, deadline.promise)
      if (w0 === "deadline") {
        this.primeOutcome = "not_written"
        return
      }

      // Step 4: surface the id. A writeKeys throw is fatal (writer/PTY dead).
      this.writeKeys(a.primeSessionIDKeys())
      wrote = true

      // Step 5: check-before-wait (a render landing right after the write, before
      // any subscription delivery, is otherwise missed), then poll under one
      // subscription until captured or the deadline fires.
      const [notify, unsubscribe] = this.screen.subscribe()
      try {
        if (await this.captureFromScreen()) {
          this.primeOutcome = "captured"
          return
        }
        let resent = false
        for (;;) {
          const which = await Promise.race([
            ctx.done().then(() => "ctx" as const),
            this.closedPromise.then(() => "closed" as const),
            notify.receive().then((r) => (r.ok ? ("changed" as const) : ("closed" as const))),
            (resent ? never : half.promise).then(() => "half" as const),
            deadline.promise.then(() => "deadline" as const),
          ])
          if (which === "ctx") throw ctx.err()
          if (which === "closed") throw ErrClosed
          if (which === "changed") {
            if (await this.captureFromScreen()) {
              this.primeOutcome = "captured"
              return
            }
            continue
          }
          if (which === "half") {
            // One-shot resend at the halfway mark: only when still empty and the
            // composer prompt is ready. Consume the latch either way (at most one).
            resent = true
            if (readyForInput(this.opts.harness, this.screen.snapshot().text)) {
              this.writeKeys(a.primeSessionIDKeys())
            }
            continue
          }
          break // deadline
        }
        // Distinguish a persist failure (box rendered + parsed, but the store
        // rejected, so the id is still empty) from a plain poll miss.
        const [, parsed] = this.extractSessionID()
        this.primeOutcome =
          parsed && this.session.harnessSessionID === ""
            ? "persist_failed"
            : "written_uncaptured"
      } finally {
        unsubscribe()
      }
    } catch (err) {
      // Capture misses are non-fatal; lifecycle/IO failures propagate. A
      // client-facing prompt we can't auto-dismiss is a miss, not a failure.
      if (err === ErrInputPending) {
        this.primeOutcome = wrote ? "written_uncaptured" : "not_written"
        return
      }
      throw err
    } finally {
      deadline.cancel()
      half.cancel()
      release()
    }
  }

  private extractSessionID(): [string, boolean] {
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.extractSessionID === "function") {
      const [id, ok] = (a.extractSessionID as (s: Snapshot) => [string, boolean])(this.screen.snapshot())
      if (ok) return [id, true]
    }
    if (typeof a.locateSessionID === "function") {
      const [id, ok] = (a.locateSessionID as (w: string) => [string, boolean])(this.opts.workingDir ?? "")
      if (ok) return [id, true]
    }
    return ["", false]
  }

  async captureRawSessionID(line: string): Promise<void> {
    if (this.session.harnessSessionID !== "") return
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.extractSessionIDFromLine !== "function") return
    const [id, ok] = (a.extractSessionIDFromLine as (l: string) => [string, boolean])(line)
    if (!ok) return
    // Route through the shared persist-before-set path (first-write mode) so raw
    // line capture gets the same correctness as the screen-scrape path.
    await this.captureAndPersistSessionID(id, /* replace */ false)
  }

  // ── History ──────────────────────────────────────────────────────────────

  async history(): Promise<Turn[]> {
    const [out] = await this.historyWithSource()
    return out
  }

  async historyWithSource(): Promise<[Turn[], HistorySource]> {
    const sessionCopy = { ...this.session }
    const a = this.adapter as unknown as Record<string, unknown>
    const hasReader = typeof a.readTranscript === "function"
    if (!hasReader || sessionCopy.harnessSessionID === "") {
      const out = await this.store.listTurns(sessionCopy.id)
      return [out, HistorySourceStore]
    }
    let tturns: { role: string; text: string; timestamp?: Date }[]
    try {
      tturns = (a.readTranscript as (id: string, wd: string) => { role: string; text: string; timestamp?: Date }[])(
        sessionCopy.harnessSessionID,
        this.opts.workingDir ?? "",
      )
    } catch (err) {
      // A not-yet-flushed (or lost) transcript degrades to store history,
      // favoring availability. Real reader failures (parse/permission/etc.)
      // rethrow so they are not silently masked.
      if (isSentinel(err, ErrSessionNotFound) || isSentinel(err, ErrEmptySessionID)) {
        const out = await this.store.listTurns(sessionCopy.id)
        return [out, HistorySourceStore]
      }
      throw err
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
    }))
    return [out, HistorySourceTranscript]
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private assistantText(snap: Snapshot): string {
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.extractMessage === "function") {
      const [msg, ok] = (a.extractMessage as (s: Snapshot) => [string, boolean])(snap)
      if (ok) return msg
    }
    return snap.text
  }

  private adapterBusy(snap: Snapshot): boolean {
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.busy === "function") {
      return (a.busy as (s: Snapshot) => boolean)(snap)
    }
    return false
  }

  private adapterQuitSequence(): Uint8Array | null {
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.quitSequence === "function") {
      return (a.quitSequence as () => Uint8Array)()
    }
    return null
  }

  private adapterRawSessionID(): boolean {
    const a = this.adapter as unknown as Record<string, unknown>
    return typeof a.extractSessionIDFromLine === "function"
  }

  private async waitReadyForSend(ctx: Context): Promise<void> {
    if (this.inputAwaitingClient()) throw ErrInputPending
    if (!requiresPromptReadiness(this.opts.harness)) return
    return this.awaitPromptReady(ctx)
  }

  /**
   * Blocks until the composer prompt is ready for a message. Owns its screen
   * subscription in a try/finally so it always unsubscribes. Throws ctx.err() on
   * cancellation, ErrClosed on close, ErrInputPending on a client-facing prompt.
   * Extracted verbatim from waitReadyForSend's loop.
   */
  private async awaitPromptReady(ctx: Context): Promise<void> {
    const [notify, unsubscribe] = this.screen.subscribe()
    try {
      if (readyForInput(this.opts.harness, this.screen.snapshot().text)) return
      for (;;) {
        const which = await Promise.race([
          ctx.done().then(() => "ctx" as const),
          this.closedPromise.then(() => "closed" as const),
          this.inputStateCh.receive().then(() => "input" as const),
          notify.receive().then((r) => r.ok ? ("notify" as const) : ("notifyClosed" as const)),
        ])
        if (which === "ctx") throw ctx.err()
        if (which === "closed") throw ErrClosed
        if (which === "notifyClosed") throw ErrClosed
        if (this.inputAwaitingClient()) throw ErrInputPending
        if (readyForInput(this.opts.harness, this.screen.snapshot().text)) return
      }
    } finally {
      unsubscribe()
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
    const [notify, unsubscribe] = this.screen.subscribe()
    try {
      if (readyForInput(this.opts.harness, this.screen.snapshot().text)) return "ready"
      for (;;) {
        const which = await Promise.race([
          ctx.done().then(() => "ctx" as const),
          this.closedPromise.then(() => "closed" as const),
          this.inputStateCh.receive().then(() => "input" as const),
          notify.receive().then((r) => r.ok ? ("notify" as const) : ("notifyClosed" as const)),
          deadlinePromise.then(() => "deadline" as const),
        ])
        if (which === "ctx") throw ctx.err()
        if (which === "closed") throw ErrClosed
        if (which === "notifyClosed") throw ErrClosed
        if (which === "deadline") return "deadline"
        if (this.inputAwaitingClient()) throw ErrInputPending
        if (readyForInput(this.opts.harness, this.screen.snapshot().text)) return "ready"
      }
    } finally {
      unsubscribe()
    }
  }

  emit(ev: ConversationEvent): void {
    this.eventCh.emit(ev)
  }

  /** Internal: start the watcher + idle pumps. Used by Open. */
  startPumps(): void {
    void this.consumeWatcher()
    void this.idleCompletionWatcher()
  }
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout>
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms)
  })
  return { promise, cancel: () => clearTimeout(timeout) }
}

function resolvePolicy(p: InputPolicy | undefined, kind: string): Disposition | null {
  if (!p) return null
  const d = p.byKind?.[kind]
  if (d && d.kind) return d
  if (p.default) return { kind: p.default }
  return null
}

function toClientInputRequest(req: TurnsInputRequest): InputRequest {
  const out: InputRequest = { id: req.id, kind: req.kind, prompt: req.prompt }
  if (req.options && req.options.length > 0) {
    out.options = req.options.map((o) => ({ id: o.id, alias: o.alias, label: o.label }))
  }
  return out
}

function findOption(req: TurnsInputRequest, s: string): TurnsInputOption | null {
  if (s === "") return null
  const ls = s.toLowerCase()
  for (const o of req.options ?? []) {
    if (o.id === s || o.alias.toLowerCase() === ls || o.label.toLowerCase() === ls) return o
  }
  return null
}

function findOptionByAlias(req: TurnsInputRequest, alias: string): TurnsInputOption | null {
  for (const o of req.options ?? []) {
    if (o.alias === alias) return o
  }
  return null
}

/** resolveAdapter maps a harness name to a concrete turns.Adapter. */
export function resolveAdapter(name: string): Adapter {
  switch (name) {
    case "codex":
      return codex.New()
    case "claude-code":
      return claudecode.New()
    case "gemini":
      return gemini.New()
    case "opencode":
      return opencode.New()
    case "pi":
      return pi.New()
    case "generic":
    case "":
      return generic.New()
    default:
      throw wrap(`chat: unknown harness: ${name}`, ErrUnknownHarness)
  }
}

/** Open starts a harness, wires the screen + turn watcher, returns a Conversation. */
export async function Open(ctx: Context | undefined, opts: Options): Promise<Conversation> {
  if (!opts.harness || !opts.binaryPath) {
    throw wrapInvalid("Harness and BinaryPath are required")
  }
  if (!opts.store) {
    throw wrapInvalid("Store is required (pass newMemStore() for the default)")
  }
  const session: Session = {
    id: newID(),
    harness: opts.harness,
    workingDir: opts.workingDir ?? "",
    createdAt: new Date(),
    // When resuming, seed with the harness session id so history/session-id
    // capture reflect the resumed session immediately rather than starting empty.
    harnessSessionID: opts.resume ?? "",
  }
  return openWithSession(ctx, opts, session, /* persist */ true)
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
  const cols = opts.cols && opts.cols > 0 ? opts.cols : 120
  const rows = opts.rows && opts.rows > 0 ? opts.rows : 40

  let adapter: Adapter
  try {
    adapter = resolveAdapter(opts.harness)
  } catch (err) {
    throw err
  }

  // Resolve resume args up front so an unsupported harness fails before launch.
  let resumeArgs: string[] = []
  if (opts.resume) {
    const ra = adapterResumeArgs(adapter, opts.resume)
    if (ra === null) {
      throw wrap(
        `chat: harness ${opts.harness} cannot resume`,
        ErrResumeUnsupported,
      )
    }
    resumeArgs = ra
  }

  // On the create path (NOT resuming), let the adapter mint its own session id
  // and the launch args that pin it, seeding harnessSessionID before persistence.
  let initArgs: string[] = []
  if (!opts.resume) {
    const init = adapterInitSession(adapter)
    if (init) {
      initArgs = init[0]
      session.harnessSessionID = init[1]
    }
  }

  // Whenever chat injects a session prefix (init OR resume), the caller must not
  // also pass raw session-control flags in opts.args — they would diverge the
  // real transcript from the persisted harnessSessionID. Reject before launch.
  const prefix = resumeArgs.length > 0 ? resumeArgs : initArgs
  if (prefix.length > 0) {
    const banned = adapterSessionControlFlags(adapter)
    const bad = firstSessionControlConflict(opts.args ?? [], banned)
    if (bad) {
      throw wrapInvalid(
        `argument ${bad} conflicts with chat-managed session control; use Options.resume / Reopen`,
      )
    }
  }

  const scr = newScreen(cols, rows)

  const c = new Conversation({
    opts: { ...opts, cols, rows },
    store: opts.store,
    adapter,
    screen: scr,
    session,
  })

  // Arm the one-shot resume-fork latch only when we seeded from a resume id AND
  // the adapter reports that `resume` forks (mints a new id). Non-forking
  // harnesses leave it disarmed, preserving strict first-write-wins.
  if (opts.resume && adapterResumeForks(adapter)) {
    c.harnessSessionIDProvisional = true
  }

  const runCtx = ctx ? { done: () => ctx.done(), err: () => ctx.err() } : undefined

  // Compute the child env ONCE, before binding, so the exact array handed to the
  // wrapper is the one the adapter parses its session dir from — binding against
  // a different env than the child receives is thus impossible.
  const env = cleanHarnessEnv(opts.env)
  ;(adapter as unknown as {
    bindLaunchEnv?: (env: string[], workingDir: string) => void
  }).bindLaunchEnv?.(env, opts.workingDir ?? "")

  const cfg = {
    binaryPath: opts.binaryPath,
    args: prefix.length > 0 ? [...prefix, ...(opts.args ?? [])] : opts.args,
    workingDir: opts.workingDir,
    // Strip Claude Code's nesting markers (CLAUDECODE / CLAUDE_CODE_*) so a
    // nested `claude` persists its JSONL transcript. When opts.env is undefined
    // this materializes the parent env, since a PTY child would otherwise
    // inherit the markers. Mirrors run.go's cleanedEnv().
    env,
    stdout: scr,
    harness: opts.harness,
    effort: opts.effort,
    model: opts.model,
    onLine: c["adapterRawSessionID"]()
      ? (line: string) => { void c.captureRawSessionID(line).catch(() => {}) }
      : undefined,
  }

  const sess = await wrapperStart(runCtx, cfg)
  c.sess = sess

  const { release, ok } = sess.acquireWriter()
  if (!ok) {
    await sess.stop()
    throw new Error("chat: failed to acquire wrapper writer lock")
  }
  c.releaseWriter = release

  sess.resize(cols, rows)

  if (persist) await opts.store.createSession({ ...c.session })

  c.watcher = Watch(sess as unknown as Parameters<typeof Watch>[0], scr, adapter)
  c.startPumps()

  // Prime the harness session id before returning the handle (Codex /status
  // scrape). Suppressed on resume (the id is already seeded). A capture miss is
  // non-fatal; a fatal lifecycle/IO failure tears the half-built session down.
  if (!opts.resume) {
    try {
      await c["primeSessionID"](ctx ?? Context.background())
    } catch (err) {
      // ctx-less close awaits actual termination (Session.stop with the cancelled
      // Open ctx would return before the process exits and leak it).
      await c.close()
      throw err
    }
  }

  return c
}

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
  sessionID: string
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
export async function Reopen(
  ctx: Context | undefined,
  opts: ReopenOptions,
): Promise<Conversation> {
  if (!opts.store) {
    throw wrapInvalid("Store is required (pass newMemStore() for the default)")
  }
  const stored = await opts.store.getSession(opts.sessionID)
  if (stored.harnessSessionID === "") {
    throw wrap(
      `chat: session ${opts.sessionID} has no harness session id`,
      ErrNoHarnessSession,
    )
  }
  const launch: Options = {
    ...opts,
    harness: stored.harness,
    workingDir: stored.workingDir,
    resume: stored.harnessSessionID,
  }
  return openWithSession(ctx, launch, { ...stored }, /* persist */ false)
}

/** Structurally probes an adapter for SessionResumer; null when unsupported. */
function adapterResumeArgs(adapter: Adapter, harnessSessionID: string): string[] | null {
  const a = adapter as unknown as Record<string, unknown>
  if (typeof a.resumeArgs !== "function") return null
  return (a.resumeArgs as (id: string) => string[])(harnessSessionID)
}

/** Structurally probes an adapter for SessionInitializer; null when unsupported. */
function adapterInitSession(adapter: Adapter): [string[], string] | null {
  const a = adapter as unknown as Record<string, unknown>
  if (typeof a.initSession !== "function") return null
  return (a.initSession as () => [string[], string])()
}

/** Structurally probes an adapter for SessionControlFlags; [] when unsupported. */
function adapterSessionControlFlags(adapter: Adapter): string[] {
  const a = adapter as unknown as Record<string, unknown>
  if (typeof a.sessionControlFlags !== "function") return []
  return (a.sessionControlFlags as () => string[])()
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
  const set = new Set(banned)
  const longFlags = banned.filter((f) => f.startsWith("--"))
  for (const tok of args) {
    if (tok === "--") break // positionals follow; never flags
    if (set.has(tok)) return tok
    for (const f of longFlags) {
      if (tok.startsWith(f + "=")) return tok
    }
  }
  return undefined
}

/**
 * Structurally probes an adapter for the optional SessionForkResumer capability.
 * Returns true only when the adapter explicitly reports that `resume` forks the
 * harness session id (mints a new one). Adapters that omit the method — Claude
 * Code, and Codex per the verified finding — default to no-fork.
 */
export function adapterResumeForks(adapter: Adapter): boolean {
  const a = adapter as unknown as Record<string, unknown>
  if (typeof a.resumeForksSessionID !== "function") return false
  return (a.resumeForksSessionID as () => boolean)() === true
}

function wrapInvalid(msg: string): Error {
  return wrap(`chat: invalid options: ${msg}`, ErrInvalidOptions)
}

export { EventBus, Signal }
