// Consumed surfaces — the Phase-4 wrapper Session and the turns Adapter/Watcher
// the chat layer sits on top of, expressed as TS interfaces.
//
// The chat layer DOES NOT reimplement supervision: it consumes these surfaces.
// They are modeled structurally here so the Conversation can be wired against the
// real wrapper/turns implementations (when present) or against an in-process fake
// (the fakeharness test util) without change. Adapter capabilities are optional
// methods — the analogue of Go's optional-interface type assertions
// (turns.Quitter, turns.BusyDetector, turns.RawSessionIDExtractor, …).

import type { Snapshot, Screen } from "../screen/index.ts";
import type { Snapshot as SessionSnapshot } from "../wrapper/index.ts";
import type { Context } from "../internal/async/index.ts";
import type { ParsedEvent } from "../transcript/event.ts";
import type { HookProvider } from "../hooks/provider.ts";

/** A blocking interactive prompt as the turns layer reports it (with keystrokes). */
export interface TurnsInputOption {
  id: string;
  alias?: string;
  label: string;
  keys: Uint8Array;
  /** Explanatory text rendered under the label, when the dialog shows one. */
  description?: string;
}

export interface TurnsInputRequest {
  id: string;
  kind: string;
  prompt: string;
  options: TurnsInputOption[];
  /** For kind "question": the dialog's header/tab label, when rendered. */
  header?: string;
  /** True when the prompt accepts multiple selections (each keys toggles). */
  multiSelect?: boolean;
  /** Bytes that commit a multi-select answer after the toggles. */
  submitKeys?: Uint8Array;
}

/** One transcript entry read from the harness's own session log. */
export interface TranscriptTurn {
  role: string;
  text: string;
  /** undefined if the log had no timestamp. */
  timestamp?: Date;
}

/** The kind of a low-level turn-state transition reported by the watcher. */
export type TurnEventKind =
  | "turn_complete"
  | "blocked"
  | "errored"
  | "tool_call"
  | "input_requested"
  | "input_resolved";

/** A low-level turn-state transition from turns.Watcher. */
export interface TurnEvent {
  kind: TurnEventKind;
  at: Date;
  reason?: string;
  snap?: Snapshot;
  httpCode?: number;
  retryAfter?: number;
  input?: TurnsInputRequest;
}

/** A receive-only stream of values (the Channel<T> read surface). */
export interface EventStream<T> {
  receive(): Promise<{ value: T | undefined; ok: boolean }>;
}

/** turns.Watcher: an ordered stream of turn events plus a Close. */
export interface Watcher {
  events(): EventStream<TurnEvent>;
  close(): Promise<void>;
  /**
   * The run-level roll-up over every raw wrapper session event: the LARGEST
   * retryAfter and whether ANY event reported an api_error. Ports Go's
   * observation struct (pkg/harness/run.go). Read after the event stream
   * completes for the final value.
   */
  observation(): { retryAfter: number; sawAPIError: boolean };
}

/**
 * The wrapper.Session surface the chat layer consumes (Phase 4). Production wires
 * the real PTY-supervised session; tests wire an in-process fake. Methods may
 * throw on failure (the analogue of a non-nil Go error return).
 */
export interface WrapperSession {
  /** Write keystrokes to the harness PTY. Returns bytes written; throws on error. */
  writeStdin(p: Uint8Array): number;
  /** Acquire the exclusive stdin-writer lock: [release, ok]. */
  acquireWriter(): [() => void, boolean];
  /** Match the PTY size to the virtual screen. */
  resize(cols: number, rows: number): void;
  /** Terminate the harness process. */
  stop(ctx: Context): Promise<void>;
  /**
   * A coherent point-in-time view of the session's liveness state (status,
   * reason, lastOutputAt). Sampled by the chat layer's activity observer. The
   * concrete wrapper Session already implements this; test fakes must too.
   */
  snapshot(): SessionSnapshot;
}

/** wrapper.Config subset the chat layer fills in at Open. */
export interface StartConfig {
  binaryPath: string;
  args?: string[];
  workingDir?: string;
  env?: string[];
  /** The screen the PTY read loop writes rendered bytes into. */
  stdout: Screen;
  harness: string;
  effort?: string;
  model?: string;
  /** Launch-time permission posture (plan|manual|ask|auto|bypass, plus the
   * per-harness native spellings). Empty/absent injects nothing. */
  permissionMode?: string;
  /** Durable, no-drop per-line tap (wired only for RawSessionIDExtractor adapters). */
  onLine?: (line: string) => void;
}

/**
 * turns.Adapter and its optional capabilities. The required surface is empty;
 * every capability is an optional method probed the way Go probes optional
 * interfaces. An Adapter that implements none still drives a Conversation (the
 * generic harness).
 */
export interface Adapter {
  /** turns.RawSessionIDExtractor — recover the harness id from a raw output line. */
  extractSessionIDFromLine?(line: string): [string, boolean];
  /**
   * turns.StreamParser — parse zero or more live transcript events from a raw
   * stream-json line. Stateless/idempotent per line; tolerates non-event lines
   * by returning []. Omitted by adapters with no interleaved stream-json.
   */
  parseStreamLine?(line: string): ParsedEvent[];
  /**
   * turns.StreamInterleaved — reports whether stream-json is emitted interleaved
   * with the interactive TUI (Stream-eligible). Omitted => not interleaved.
   */
  streamInterleaved?(): boolean;
  /** turns.SessionIDExtractor — scrape the id from the rendered screen. */
  extractSessionID?(snap: Snapshot): [string, boolean];
  /** turns.SessionIDLocator — locate the id from the on-disk session log. */
  locateSessionID?(workingDir: string): [string, boolean];
  /** turns.SessionIDPrimer — keystrokes that surface the session id on screen. */
  primeSessionIDKeys?(): Uint8Array;
  /** turns.TranscriptReader — read the harness's own JSONL session log. */
  readTranscript?(
    harnessSessionID: string,
    workingDir: string,
  ): TranscriptTurn[];
  /** turns.MessageExtractor — isolate the clean assistant reply from the TUI. */
  extractMessage?(snap: Snapshot): [string, boolean];
  /** turns.BusyDetector — report whether the harness is still working. */
  busy?(snap: Snapshot): boolean;
  /**
   * turns.SwallowedPromptDetector — report whether a settled screen shows no
   * assistant output for the in-flight turn (the prompt was never accepted).
   * Consulted only on the idle-completion fallback path; omitted => never.
   */
  promptNotAccepted?(snap: Snapshot, sentScreenText: string): boolean;
  /** turns.Quitter — the graceful-exit keystroke sequence. */
  quitSequence?(): Uint8Array;
  /**
   * turns.PermissionModeCycler — one keystroke that advances the harness's
   * permission-mode ring by exactly one rung.
   *
   * Like every other optional entry here this is DOCUMENTATION of the
   * optional-capability set, NOT compile-time checking: the chat-side probes
   * cast the adapter to Record<string, unknown> and never consult AdapterDeps
   * (see adapterQuitSequence, src/chat/conversation.ts). The only real guards
   * are the runtime `typeof … === "function"` probe at the call site and the
   * contract test asserting exactly which adapters expose the method.
   */
  permissionCycleKeys?(): Uint8Array;
  /**
   * turns.PermissionsDialogCapability — the harness's structured permission-
   * preset dialog (codex's "/permissions" picker), probed structurally like
   * every other optional capability here. Omitted => the harness has no such
   * dialog surface.
   */
  permissionsDialogKeys?(): Uint8Array;
  /** turns.PermissionsDialogCapability — back out WITHOUT committing a preset. */
  dialogBackoutKeys?(): Uint8Array;
  /** turns.PermissionsDialogCapability — empty a composer holding literal text. */
  composerClearKeys?(): Uint8Array;
  /** turns.PermissionsDialogCapability — does the composer still carry text? */
  composerHasText?(snap: Snapshot): boolean;
  /** turns.PermissionsDialogCapability — the preset-commit containment gate. */
  permissionsWriteContained?(declaredHome: string): boolean;
  /**
   * turns.SessionForkResumer — reports whether `resume` mints a NEW harness
   * session id (forks) rather than continuing the old one. When true, the chat
   * layer arms a one-shot provisional refresh of the seeded id. Omitted =>
   * no-fork (Claude Code; Codex, per the empirically-verified 0.142 finding).
   */
  resumeForksSessionID?(): boolean;
  /** turns.SessionResumer — argv fragment that resumes a prior harness session. */
  resumeArgs?(harnessSessionID: string): string[];
  /** turns.SessionInitializer — mint a fresh session id + the argv that pins it. */
  initSession?(): [string[], string];
  /** turns.SessionControlFlags — flags chat manages, banned from Options.args. */
  sessionControlFlags?(): string[];
  /**
   * Pi-style capability: chat calls this once at Open with the effective child
   * env and cwd so an adapter can pin where it reads its session log from.
   */
  bindLaunchEnv?(env: string[], workingDir: string): void;
  /**
   * turns.HookProviderCapability — surface the harness's HookProvider, whose
   * ensureConfig installs/rewrites the managed on-disk hook block and whose
   * parsePayload parses native hook payloads into canonical Events. Probed
   * structurally, like readTranscript; omitted => no managed-hook integration.
   */
  hookProvider?(): HookProvider;
}

/**
 * Backend wires the chat layer's three injected dependencies: adapter
 * resolution, session start, and watcher construction. Open consumes it so the
 * same Conversation logic runs against the real wrapper/turns layers or an
 * in-process fake.
 */
export interface Backend {
  /** Map Options.harness to a turns.Adapter; throws ErrUnknownHarness if unknown. */
  resolveAdapter(name: string): Adapter;
  /** wrapper.Start: launch the harness and return its supervised session. */
  start(cfg: StartConfig): Promise<WrapperSession>;
  /** turns.Watch: build the turn-state watcher over (session, screen, adapter). */
  watch(sess: WrapperSession, screen: Screen, adapter: Adapter): Watcher;
}
