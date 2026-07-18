// Chat-level data types — the TS port of pkg/chat's value types (chat.go,
// input.go, store.go). Pure data + the Store interface; no runtime behavior
// beyond newID.

/** Role identifies who produced a turn. */
export type Role = "user" | "assistant" | "system";

export const RoleUser: Role = "user";
export const RoleAssistant: Role = "assistant";
export const RoleSystem: Role = "system";

/** TurnState is the lifecycle stage of a Turn. */
export type TurnState = "pending" | "streaming" | "complete" | "errored";

export const TurnStatePending: TurnState = "pending";
export const TurnStateStreaming: TurnState = "streaming";
export const TurnStateComplete: TurnState = "complete";
export const TurnStateErrored: TurnState = "errored";

/** Turn is one message in the conversation. */
export interface Turn {
  id: string;
  sessionID: string;
  role: Role;
  state: TurnState;
  /** Populated for user turns at send time and for assistant turns from the screen extract once complete. */
  text: string;
  /** Non-empty for errored turns; mirrors adapter event reason. */
  reason: string;
  startedAt: Date;
  completedAt: Date;
  /** Upstream API status code carried with a Blocked transition; 0 otherwise. */
  httpCode: number;
  /** Wait duration (ms) parsed from the harness error message; 0 when none. */
  retryAfter: number;
}

/** EventType discriminates the variants of a ConversationEvent. */
export type EventType = "turn" | "input_request" | "input_resolved";

export const EventTurn: EventType = "turn";
export const EventInputRequest: EventType = "input_request";
export const EventInputResolved: EventType = "input_resolved";

/** A discriminated event observed on Conversation.events(). */
export interface ConversationEvent {
  type: EventType;
  /** Populated for EventTurn; omitted (undefined) for non-turn events. */
  turn?: Turn;
  /** The interactive prompt for input events; undefined for EventTurn. */
  input?: InputRequest;
  /** Non-nil for out-of-band errors (e.g. Store failures). */
  err?: unknown;
}

/** The chat-level session record. Distinct from the wrapper session. */
export interface Session {
  id: string;
  harness: string;
  workingDir: string;
  createdAt: Date;
  /** The ID the underlying harness assigned to its own session; empty until extracted. */
  harnessSessionID: string;
}

/** Client-facing view of a blocking interactive prompt (omits keystrokes). */
export interface InputRequest {
  id: string;
  /**
   * "trust_prompt" | "question" (the harness asked a clarifying question
   * mid-turn) | "question_review" (the submit/cancel confirmation after the
   * last question of a multi-question/multi-select dialog) | harness kinds.
   */
  kind: string;
  prompt: string;
  options?: InputOption[];
  /** For kind "question": the dialog's header/tab label, when rendered. */
  header?: string;
  /** True when the prompt accepts MULTIPLE selections; answer with optionIDs. */
  multiSelect?: boolean;
}

/** One selectable choice in an InputRequest. */
export interface InputOption {
  id: string;
  alias?: string;
  label: string;
  /** Explanatory text rendered under the label, when the dialog shows one. */
  description?: string;
}

/** How a caller answers an InputRequest. */
export interface InputAnswer {
  optionID?: string;
  /**
   * For multiSelect requests: every option to toggle before the answer is
   * committed. Takes precedence over optionID when non-empty.
   */
  optionIDs?: string[];
  text?: string;
}

/** How a policy disposes of a matched InputRequest. */
export type DispositionKind = "ask" | "answer" | "deny";

export const DispositionAsk: DispositionKind = "ask";
export const DispositionAnswer: DispositionKind = "answer";
export const DispositionDeny: DispositionKind = "deny";

/** The action a policy takes for a matched request kind. */
export interface Disposition {
  kind: DispositionKind;
  optionID?: string;
  text?: string;
}

/** Pre-configures how interactive prompts are resolved without a live client. */
export interface InputPolicy {
  /** Applies when byKind has no entry; empty means "ask". */
  default?: DispositionKind;
  /** Maps an InputRequest.kind to its action. */
  byKind?: Record<string, Disposition>;
}

/** Identifies where a History result came from. */
export type HistorySource = "transcript" | "store";

export const HistorySourceTranscript: HistorySource = "transcript";
export const HistorySourceStore: HistorySource = "store";

/** newID returns a fresh 16-byte hex ID. */
export function newID(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
