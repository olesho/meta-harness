// turns translates low-level harness signals — emulated screen state changes
// and wrapper-level status events — into a small vocabulary of chat-oriented
// turn events: turn complete, tool call, blocked, errored, input requested.
//
// Adapters implement the per-harness logic. A generic fallback adapter (see
// ./generic.ts) maps wrapper.Status to turn events without looking at the
// screen at all; per-harness adapters live in ./harness/<name>.ts and add
// screen-derived signals such as prompt-region detection and tool-call markers.
//
// Port of pkg/turns/turns.go.

import type { Snapshot } from "../screen/index.ts"
import type { Status } from "./wrapper.ts"

/**
 * Kind is the categorical type of a turn event. The vocabulary is intentionally
 * small; adapters with richer signals attach details via Event.reason / .snap
 * rather than growing the kind set.
 */
export type Kind =
  | "turn_complete"
  | "tool_call"
  | "blocked"
  | "errored"
  | "input_requested"
  | "input_resolved"

/** Assistant finished its turn; the caller may send the next user message. */
export const TurnComplete: Kind = "turn_complete"
/** Harness is invoking a tool. Informational; the turn is still in progress. */
export const ToolCall: Kind = "tool_call"
/** Transient block (cost/quota/rate-limit). Back off and retry. */
export const Blocked: Kind = "blocked"
/** Terminal failure; the turn did not complete and is unlikely to recover. */
export const Errored: Kind = "errored"
/** Harness is blocked on an interactive prompt; see Event.input. */
export const InputRequested: Kind = "input_requested"
/** A previously-requested interactive prompt is no longer on screen. */
export const InputResolved: Kind = "input_resolved"

/** One observation about the conversation flow. Mirrors turns.Event. */
export interface Event {
  /** Categorizes the event. */
  kind: Kind
  /** When observed; the Watcher backfills from the originating event. */
  at?: Date
  /** Short human-readable description; not stable for parsing. */
  reason: string
  /** Screen snapshot at the moment a screen-derived event fired. */
  snap?: Snapshot
  /** Upstream API status code, copied from the SessionEvent by the Watcher. */
  httpCode?: number
  /** Parsed retry hint (ms), copied from the SessionEvent by the Watcher. */
  retryAfter?: number
  /** Structured interactive prompt for input_requested / input_resolved. */
  input?: InputRequest
}

/**
 * A blocking interactive prompt detected on screen that must be answered
 * out-of-band — the normal Send message flow cannot satisfy it.
 */
export interface InputRequest {
  /** Stable across redraws of the SAME prompt; changes for a new prompt. */
  id: string
  /** "trust_prompt" | "menu_select" | "confirm" | "text_input" | harness kinds. */
  kind: string
  /** The question text shown to the user. */
  prompt: string
  /** Selectable choices for menu/confirm/trust prompts; undefined for text. */
  options?: InputOption[]
}

/** One selectable choice in an InputRequest. */
export interface InputOption {
  /** Stable identifier the answer references (e.g. "1"). */
  id: string
  /** Portable intent: "proceed" | "deny" | "yes" | "no" | "" (none). */
  alias: string
  /** Human-readable choice text ("Yes, proceed"). */
  label: string
  /** Bytes to write to the PTY to select this option (server-side only). */
  keys: Uint8Array
}

/**
 * The per-harness contract that translates raw signals (screen state + wrapper
 * status) into turn events. Mirrors turns.Adapter.
 */
export interface Adapter {
  /** Identifies the adapter ("generic", "codex", "claude-code", …). */
  name(): string
  /** Called after every successful screen write; returns any turn events. */
  onScreen(snap: Snapshot): Event[]
  /** Called on every wrapper status event; returns any turn events. */
  onWrapperStatus(status: Status, reason: string): Event[]
}

// ── Optional capability interfaces ──────────────────────────────────────────
// Adapters may implement any subset. The chat layer probes structurally.

/** Surfaces the harness session ID by scraping the rendered screen. */
export interface SessionIDExtractor {
  /** Returns [id, true] when the ID is visible, else ["", false]. */
  extractSessionID(snap: Snapshot): [string, boolean]
}

/** Surfaces the harness session ID from a single RAW PTY output line. */
export interface RawSessionIDExtractor {
  extractSessionIDFromLine(line: string): [string, boolean]
}

/** Recovers the harness session ID from on-disk state, keyed on workingDir. */
export interface SessionIDLocator {
  locateSessionID(workingDir: string): [string, boolean]
}

/** Supplies keystrokes that make the harness print its session id on screen. */
export interface SessionIDPrimer {
  /** Full keystrokes (command + submit) that surface the session id once. */
  primeSessionIDKeys(): Uint8Array
}

/** Provides access to the harness's persisted conversation log. */
export interface TranscriptReader {
  readTranscript(harnessSessionID: string, workingDir: string): Turn[]
}

/** Surfaces the key sequence that makes the harness exit gracefully. */
export interface Quitter {
  quitSequence(): Uint8Array
}

/** Recovers the assistant's reply text from the rendered screen. */
export interface MessageExtractor {
  /** Returns [message, true] or ["", false] when it can't isolate one. */
  extractMessage(snap: Snapshot): [string, boolean]
}

/** Reports whether the harness is still working on the current turn. */
export interface BusyDetector {
  busy(snap: Snapshot): boolean
}

/** Builds the launch args that make the harness resume a prior session. */
export interface SessionResumer {
  /** Returns the argv fragment resuming the given harness session id. */
  resumeArgs(harnessSessionID: string): string[]
}

/** Mints a fresh harness session id and the launch args that pin it. */
export interface SessionInitializer {
  /** Returns [args, id]: an argv fragment that creates session <id>, plus <id>. */
  initSession(): [string[], string]
}

/** Lists caller argv flags that conflict with chat-managed session control. */
export interface SessionControlFlags {
  /** Flags (e.g. "--session", "--fork") that must not appear in Options.args. */
  sessionControlFlags(): string[]
}

/**
 * Reports whether resuming forks the harness session id — i.e. `resume <id>`
 * starts a NEW session with a freshly-minted id rather than continuing <id>.
 * Implemented only by adapters whose harness forks; the chat layer arms a
 * one-shot provisional id refresh when it returns true. Omitting the interface
 * entirely means "does not fork" (the common case).
 */
export interface SessionForkResumer {
  resumeForksSessionID(): boolean
}

/**
 * One message read from a harness session log. Mirrors transcript.Turn; kept
 * here as a structural type until the transcript layer is ported.
 */
export interface Turn {
  /** "user", "assistant", or "system". */
  role: string
  /** The message body; multi-block messages joined with "\n\n". */
  text: string
  /** When the message was recorded; undefined if the log had no timestamp. */
  timestamp?: Date
}
