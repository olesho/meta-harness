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

import type { ParsedEvent } from "../transcript/event.ts";
import type { Snapshot } from "../screen/index.ts";
import type { Status } from "./wrapper.ts";
import type { HookProvider } from "../hooks/provider.ts";

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
  | "input_resolved";

/** Assistant finished its turn; the caller may send the next user message. */
export const TurnComplete: Kind = "turn_complete";
/** Harness is invoking a tool. Informational; the turn is still in progress. */
export const ToolCall: Kind = "tool_call";
/** Transient block (cost/quota/rate-limit). Back off and retry. */
export const Blocked: Kind = "blocked";
/** Terminal failure; the turn did not complete and is unlikely to recover. */
export const Errored: Kind = "errored";
/** Harness is blocked on an interactive prompt; see Event.input. */
export const InputRequested: Kind = "input_requested";
/** A previously-requested interactive prompt is no longer on screen. */
export const InputResolved: Kind = "input_resolved";

/**
 * AcquisitionMode selects HOW live transcript events are acquired for a run.
 * Mirrors harness-wrapper's pkg/harness Mode (renamed here to keep the bare
 * name `Mode` free in MH, where "mode" is ambiguous across the wrapper's
 * model/effort knobs and the permission knob planned in META-HARNESS-100).
 * Values:
 *
 *   - Off    — no live acquisition; the run relies on the on-disk transcript.
 *   - Stream — parse events from the harness's stream-json interleaved with the
 *     interactive TUI (via a StreamParser + the PTY line tap).
 *   - Hooks  — the harness emits events through a hooks side-channel.
 *
 * Go's Mode also carries an `Auto`, but only as a pre-resolution placeholder
 * that it latches to Stream|Hooks BEFORE any event is filtered. MH resolves the
 * concrete mode in planAcquisition directly, so there is no un-latched Auto
 * value in THIS resolved union to leak into the event path. MH expresses Go's
 * Auto placeholder instead as the request-only `RequestedAcquisitionMode`
 * token below — consumed by planAcquisition and NEVER emitted by it.
 */
export type AcquisitionMode = "off" | "stream" | "hooks";

/** No live acquisition; fall back to the on-disk transcript. */
export const AcquisitionModeOff: AcquisitionMode = "off";
/** Parse events from stream-json interleaved with the interactive TUI. */
export const AcquisitionModeStream: AcquisitionMode = "stream";
/** Acquire events from the harness hooks side-channel. */
export const AcquisitionModeHooks: AcquisitionMode = "hooks";

/**
 * RequestedAcquisitionMode is the request-only superset: the mode a CALLER may
 * ask for. `auto` = "best available channel"; planAcquisition resolves it (to a
 * concrete AcquisitionMode) and NEVER emits it. Mirrors Go's TranscriptAuto
 * placeholder without adding an un-latched value to the resolved
 * AcquisitionMode union (see the note above) — so `auto` can never reach the
 * event path (StreamTap.mode, admitParent, describeAcquisitionMode).
 */
export type RequestedAcquisitionMode = AcquisitionMode | "auto";

/**
 * AcquisitionModeAuto is the request-only "best available channel" token.
 * planAcquisition resolves it identically to a requested Hooks (hooks-if-viable
 * → stream-if-eligible → Off); it is never returned as a resolved mode.
 */
export const AcquisitionModeAuto = "auto" as const;

/**
 * describeAcquisitionMode renders an AcquisitionMode for logs — the
 * `String()`-equivalent of Go's Mode.String(). Returns the canonical lowercase
 * label ("off" | "stream" | "hooks").
 */
export function describeAcquisitionMode(
  m: AcquisitionMode,
): "off" | "stream" | "hooks" {
  switch (m) {
    case "off":
      return "off";
    case "stream":
      return "stream";
    case "hooks":
      return "hooks";
  }
}

/** One observation about the conversation flow. Mirrors turns.Event. */
export interface Event {
  /** Categorizes the event. */
  kind: Kind;
  /** When observed; the Watcher backfills from the originating event. */
  at?: Date;
  /** Short human-readable description; not stable for parsing. */
  reason: string;
  /** Screen snapshot at the moment a screen-derived event fired. */
  snap?: Snapshot;
  /** Upstream API status code, copied from the SessionEvent by the Watcher. */
  httpCode?: number;
  /** Parsed retry hint (ms), copied from the SessionEvent by the Watcher. */
  retryAfter?: number;
  /** Structured interactive prompt for input_requested / input_resolved. */
  input?: InputRequest;
}

/**
 * A blocking interactive prompt detected on screen that must be answered
 * out-of-band — the normal Send message flow cannot satisfy it.
 */
export interface InputRequest {
  /** Stable across redraws of the SAME prompt; changes for a new prompt. */
  id: string;
  /**
   * "trust_prompt" | "menu_select" | "confirm" | "text_input" | "question"
   * (the harness asked the user a clarifying question mid-turn) |
   * "question_review" (the submit/cancel confirmation after the last
   * question of a multi-question or multi-select dialog) | harness kinds.
   */
  kind: string;
  /** The question text shown to the user. */
  prompt: string;
  /** Selectable choices for menu/confirm/trust prompts; undefined for text. */
  options?: InputOption[];
  /** For kind "question": the dialog's header/tab label, when rendered. */
  header?: string;
  /**
   * For kind "question": true when the dialog accepts MULTIPLE selections
   * (checkbox rows). Each option's keys then TOGGLE that choice; write
   * submitKeys after toggling to commit (which surfaces a "question_review"
   * request for the final confirmation).
   */
  multiSelect?: boolean;
  /** Bytes that commit a multi-select answer after toggles (server-side only). */
  submitKeys?: Uint8Array;
}

/** One selectable choice in an InputRequest. */
export interface InputOption {
  /** Stable identifier the answer references (e.g. "1"). */
  id: string;
  /**
   * Portable intent: "proceed" | "deny" | "yes" | "no" | "other" (free-text
   * escape hatch — selecting it declines the structured question and returns
   * control to the composer) | "" (none).
   */
  alias: string;
  /** Human-readable choice text ("Yes, proceed"). */
  label: string;
  /** Bytes to write to the PTY to select this option (server-side only). */
  keys: Uint8Array;
  /** Explanatory text rendered under the label, when the dialog shows one. */
  description?: string;
  /**
   * True when the menu rendered this row as the currently-selected choice (the
   * codex "›" highlight marker). Server-side only — stripped by
   * toClientInputRequest and excluded from the InputRequest id hash. Used by the
   * codex approval-prompt gate to require a live selector on a parsed row, so a
   * quoted-prose spoof (no live highlight) cannot false-positive. Absent on
   * harnesses/menus that do not render a selector.
   */
  highlighted?: boolean;
}

/**
 * The per-harness contract that translates raw signals (screen state + wrapper
 * status) into turn events. Mirrors turns.Adapter.
 */
export interface Adapter {
  /** Identifies the adapter ("generic", "codex", "claude-code", …). */
  name(): string;
  /** Called after every successful screen write; returns any turn events. */
  onScreen(snap: Snapshot): Event[];
  /** Called on every wrapper status event; returns any turn events. */
  onWrapperStatus(status: Status, reason: string): Event[];
}

// ── Optional capability interfaces ──────────────────────────────────────────
// Adapters may implement any subset. The chat layer probes structurally.

/** Surfaces the harness session ID by scraping the rendered screen. */
export interface SessionIDExtractor {
  /** Returns [id, true] when the ID is visible, else ["", false]. */
  extractSessionID(snap: Snapshot): [string, boolean];
}

/** Surfaces the harness session ID from a single RAW PTY output line. */
export interface RawSessionIDExtractor {
  extractSessionIDFromLine(line: string): [string, boolean];
}

/** Recovers the harness session ID from on-disk state, keyed on workingDir. */
export interface SessionIDLocator {
  locateSessionID(workingDir: string): [string, boolean];
}

/** Supplies keystrokes that make the harness print its session id on screen. */
export interface SessionIDPrimer {
  /** Full keystrokes (command + submit) that surface the session id once. */
  primeSessionIDKeys(): Uint8Array;
}

/** Provides access to the harness's persisted conversation log. */
export interface TranscriptReader {
  readTranscript(harnessSessionID: string, workingDir: string): Turn[];
}

/** Surfaces the key sequence that makes the harness exit gracefully. */
export interface Quitter {
  quitSequence(): Uint8Array;
}

/** Supplies the keystroke that advances the harness's permission-mode ring. */
export interface PermissionModeCycler {
  /** One press that advances the ring by exactly one rung. */
  permissionCycleKeys(): Uint8Array;
}

/** Recovers the assistant's reply text from the rendered screen. */
export interface MessageExtractor {
  /** Returns [message, true] or ["", false] when it can't isolate one. */
  extractMessage(snap: Snapshot): [string, boolean];
}

/** Reports whether the harness is still working on the current turn. */
export interface BusyDetector {
  busy(snap: Snapshot): boolean;
}

/**
 * Detects a swallowed prompt: the composer settled back to a ready screen that
 * shows no assistant output for the in-flight turn. The chat layer consults it
 * before its idle-completion fallback (no end-of-turn marker observed) so such
 * a screen errors the turn instead of completing it with the raw ready screen
 * as the "reply". `sentScreenText` is the rendered screen at submit time.
 */
export interface SwallowedPromptDetector {
  promptNotAccepted(snap: Snapshot, sentScreenText: string): boolean;
}

/** Builds the launch args that make the harness resume a prior session. */
export interface SessionResumer {
  /** Returns the argv fragment resuming the given harness session id. */
  resumeArgs(harnessSessionID: string): string[];
}

/** Mints a fresh harness session id and the launch args that pin it. */
export interface SessionInitializer {
  /** Returns [args, id]: an argv fragment that creates session <id>, plus <id>. */
  initSession(): [string[], string];
}

/** Lists caller argv flags that conflict with chat-managed session control. */
export interface SessionControlFlags {
  /** Flags (e.g. "--session", "--fork") that must not appear in Options.args. */
  sessionControlFlags(): string[];
}

/**
 * Reports whether resuming forks the harness session id — i.e. `resume <id>`
 * starts a NEW session with a freshly-minted id rather than continuing <id>.
 * Implemented only by adapters whose harness forks; the chat layer arms a
 * one-shot provisional id refresh when it returns true. Omitting the interface
 * entirely means "does not fork" (the common case).
 */
export interface SessionForkResumer {
  resumeForksSessionID(): boolean;
}

/**
 * Parses live transcript events out of a single RAW harness stream-json line.
 * Mirrors harness-wrapper's pkg/harness StreamParser.
 *
 * Contract:
 *   - STATELESS and IDEMPOTENT per line: parsing a line never depends on, or
 *     mutates, state carried between calls; the same input always yields the
 *     same output.
 *   - One input line yields ZERO OR MORE ParsedEvents — an assistant line can
 *     carry both a text block and a tool_use block, so a single line fans out
 *     to multiple events.
 *   - It MUST TOLERATE non-event lines — non-JSON, ANSI-polluted, and
 *     system/result lines — by returning an empty array rather than throwing,
 *     because the PTY line tap delivers raw bytes with no framing guarantees.
 *   - Each returned event is tagged source=live (transcript SourceLive). The
 *     caller (StreamTap, a later subtask) stamps run/harness ids and assigns the
 *     monotonic seq from arrival order; the parser leaves those unset.
 */
export interface StreamParser {
  parseStreamLine(line: string): ParsedEvent[];
}

/**
 * Reports whether the adapter's stream-json is emitted INTERLEAVED with the
 * interactive TUI (so a StreamParser can tap it live) versus only via a
 * non-interactive launch that suppresses the TUI. planAcquisition consults this
 * to decide Stream-eligibility: only an interleaved adapter is Stream-eligible.
 *
 * All four A1 adapters return false (see each adapter's note), so the Stream
 * branch is scaffolding until an interleaving adapter lights it up. Omitting the
 * interface entirely means "not interleaved" (the conservative default).
 */
export interface StreamInterleaved {
  streamInterleaved(): boolean;
}

/**
 * Surfaces the harness's managed-hook integration: a HookProvider whose
 * ensureConfig installs/rewrites the managed on-disk hook block (config-ensure)
 * and whose parsePayload turns the harness's native hook payloads into
 * canonical transcript Events (payload-parse). Probed structurally — the same
 * Go-optional-interface style as TranscriptReader / SessionIDExtractor —
 * so the chat layer discovers hook support without a separate registry.
 *
 * Implemented only by adapters whose harness ships a managed-hook surface
 * (Claude Code). Omitting the interface entirely means "no managed hooks".
 */
export interface HookProviderCapability {
  /** Returns the harness's HookProvider (config-ensure + payload-parse). */
  hookProvider(): HookProvider;
}

/**
 * One message read from a harness session log. Mirrors transcript.Turn; kept
 * here as a structural type until the transcript layer is ported.
 */
export interface Turn {
  /** "user", "assistant", or "system". */
  role: string;
  /** The message body; multi-block messages joined with "\n\n". */
  text: string;
  /** When the message was recorded; undefined if the log had no timestamp. */
  timestamp?: Date;
}
