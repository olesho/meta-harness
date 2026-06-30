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
import { Context, wrap } from "../internal/async/index.ts"
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
} from "./errors.ts"
import { ControlQueue, newControlQueue } from "./control.ts"
import { submitKeyForHarness, requiresPromptReadiness, readyForInput } from "./ready.ts"

/** Options configures a single Conversation. Mirrors chat.Options. */
export interface Options {
  /** Per-harness adapter name. Required. */
  harness: string
  /** The harness executable. Required. */
  binaryPath: string
  args?: string[]
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
}

const enc = new TextEncoder()

// idleCompletionGap — how long the screen must sit unchanged at the ready prompt
// before the idle fallback completes an in-flight turn. (ms)
const idleCompletionGap = 8000
// markerConfirmGap — the shorter quiet window used once an end-of-turn marker has
// been seen. (ms)
const markerConfirmGap = 2000

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
      this.maybeExtractSessionID()

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

    this.maybeExtractSessionID()

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

  maybeExtractSessionID(): void {
    if (this.session.harnessSessionID !== "") return
    const [id, ok] = this.extractSessionID()
    if (!ok) return
    this.session.harnessSessionID = id
    void this.store.updateSession({ ...this.session })
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

  captureRawSessionID(line: string): void {
    if (this.session.harnessSessionID !== "") return
    const a = this.adapter as unknown as Record<string, unknown>
    if (typeof a.extractSessionIDFromLine !== "function") return
    const [id, ok] = (a.extractSessionIDFromLine as (l: string) => [string, boolean])(line)
    if (!ok) return
    if (this.session.harnessSessionID !== "") return
    this.session.harnessSessionID = id
    void this.store.updateSession({ ...this.session })
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
    const tturns = (a.readTranscript as (id: string, wd: string) => { role: string; text: string; timestamp?: Date }[])(
      sessionCopy.harnessSessionID,
      this.opts.workingDir ?? "",
    )
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
  const cols = opts.cols && opts.cols > 0 ? opts.cols : 120
  const rows = opts.rows && opts.rows > 0 ? opts.rows : 40

  let adapter: Adapter
  try {
    adapter = resolveAdapter(opts.harness)
  } catch (err) {
    throw err
  }

  const scr = newScreen(cols, rows)

  const c = new Conversation({
    opts: { ...opts, cols, rows },
    store: opts.store,
    adapter,
    screen: scr,
    session: {
      id: newID(),
      harness: opts.harness,
      workingDir: opts.workingDir ?? "",
      createdAt: new Date(),
      harnessSessionID: "",
    },
  })

  const runCtx = ctx ? { done: () => ctx.done(), err: () => ctx.err() } : undefined

  const cfg = {
    binaryPath: opts.binaryPath,
    args: opts.args,
    workingDir: opts.workingDir,
    env: opts.env,
    stdout: scr,
    harness: opts.harness,
    effort: opts.effort,
    model: opts.model,
    onLine: c["adapterRawSessionID"]() ? (line: string) => c.captureRawSessionID(line) : undefined,
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

  await opts.store.createSession({ ...c.session })

  c.watcher = Watch(sess as unknown as Parameters<typeof Watch>[0], scr, adapter)
  c.startPumps()

  return c
}

function wrapInvalid(msg: string): Error {
  return wrap(`chat: invalid options: ${msg}`, ErrInvalidOptions)
}

export { EventBus, Signal }
