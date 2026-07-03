// Consumed surfaces — the Phase-4 wrapper Session and the turns Adapter/Watcher
// the chat layer sits on top of, expressed as TS interfaces.
//
// The chat layer DOES NOT reimplement supervision: it consumes these surfaces.
// They are modeled structurally here so the Conversation can be wired against the
// real wrapper/turns implementations (when present) or against an in-process fake
// (the fakeharness test util) without change. Adapter capabilities are optional
// methods — the analogue of Go's optional-interface type assertions
// (turns.Quitter, turns.BusyDetector, turns.RawSessionIDExtractor, …).

import type { Snapshot, Screen } from "../screen/index.ts"
import type { Context } from "../internal/async/index.ts"

/** A blocking interactive prompt as the turns layer reports it (with keystrokes). */
export interface TurnsInputOption {
  id: string
  alias?: string
  label: string
  keys: Uint8Array
}

export interface TurnsInputRequest {
  id: string
  kind: string
  prompt: string
  options: TurnsInputOption[]
}

/** One transcript entry read from the harness's own session log. */
export interface TranscriptTurn {
  role: string
  text: string
  timestamp: Date
}

/** The kind of a low-level turn-state transition reported by the watcher. */
export type TurnEventKind =
  | "turn_complete"
  | "blocked"
  | "errored"
  | "tool_call"
  | "input_requested"
  | "input_resolved"

/** A low-level turn-state transition from turns.Watcher. */
export interface TurnEvent {
  kind: TurnEventKind
  at: Date
  reason?: string
  snap?: Snapshot
  httpCode?: number
  retryAfter?: number
  input?: TurnsInputRequest
}

/** A receive-only stream of values (the Channel<T> read surface). */
export interface EventStream<T> {
  receive(): Promise<{ value: T | undefined; ok: boolean }>
}

/** turns.Watcher: an ordered stream of turn events plus a Close. */
export interface Watcher {
  events(): EventStream<TurnEvent>
  close(): Promise<void>
}

/**
 * The wrapper.Session surface the chat layer consumes (Phase 4). Production wires
 * the real PTY-supervised session; tests wire an in-process fake. Methods may
 * throw on failure (the analogue of a non-nil Go error return).
 */
export interface WrapperSession {
  /** Write keystrokes to the harness PTY. Returns bytes written; throws on error. */
  writeStdin(p: Uint8Array): number
  /** Acquire the exclusive stdin-writer lock: [release, ok]. */
  acquireWriter(): [() => void, boolean]
  /** Match the PTY size to the virtual screen. */
  resize(cols: number, rows: number): void
  /** Terminate the harness process. */
  stop(ctx: Context): Promise<void>
}

/** wrapper.Config subset the chat layer fills in at Open. */
export interface StartConfig {
  binaryPath: string
  args?: string[]
  workingDir?: string
  env?: string[]
  /** The screen the PTY read loop writes rendered bytes into. */
  stdout: Screen
  harness: string
  effort?: string
  model?: string
  /** Durable, no-drop per-line tap (wired only for RawSessionIDExtractor adapters). */
  onLine?: (line: string) => void
}

/**
 * turns.Adapter and its optional capabilities. The required surface is empty;
 * every capability is an optional method probed the way Go probes optional
 * interfaces. An Adapter that implements none still drives a Conversation (the
 * generic harness).
 */
export interface Adapter {
  /** turns.RawSessionIDExtractor — recover the harness id from a raw output line. */
  extractSessionIDFromLine?(line: string): [string, boolean]
  /** turns.SessionIDExtractor — scrape the id from the rendered screen. */
  extractSessionID?(snap: Snapshot): [string, boolean]
  /** turns.SessionIDLocator — locate the id from the on-disk session log. */
  locateSessionID?(workingDir: string): [string, boolean]
  /** turns.TranscriptReader — read the harness's own JSONL session log. */
  readTranscript?(harnessSessionID: string, workingDir: string): TranscriptTurn[]
  /** turns.MessageExtractor — isolate the clean assistant reply from the TUI. */
  extractMessage?(snap: Snapshot): [string, boolean]
  /** turns.BusyDetector — report whether the harness is still working. */
  busy?(snap: Snapshot): boolean
  /** turns.Quitter — the graceful-exit keystroke sequence. */
  quitSequence?(): Uint8Array
  /**
   * turns.SessionForkResumer — reports whether `resume` mints a NEW harness
   * session id (forks) rather than continuing the old one. When true, the chat
   * layer arms a one-shot provisional refresh of the seeded id. Omitted =>
   * no-fork (Claude Code; Codex, per the empirically-verified 0.142 finding).
   */
  resumeForksSessionID?(): boolean
}

/**
 * Backend wires the chat layer's three injected dependencies: adapter
 * resolution, session start, and watcher construction. Open consumes it so the
 * same Conversation logic runs against the real wrapper/turns layers or an
 * in-process fake.
 */
export interface Backend {
  /** Map Options.harness to a turns.Adapter; throws ErrUnknownHarness if unknown. */
  resolveAdapter(name: string): Adapter
  /** wrapper.Start: launch the harness and return its supervised session. */
  start(cfg: StartConfig): Promise<WrapperSession>
  /** turns.Watch: build the turn-state watcher over (session, screen, adapter). */
  watch(sess: WrapperSession, screen: Screen, adapter: Adapter): Watcher
}
