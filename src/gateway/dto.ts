// Gateway wire DTOs — the JSON serialization layer for the meta-harness-chatd
// HTTP+SSE daemon. Ported from the Go `cmd/harness-chatd` `types.go` converters
// (toTurnDTO / toInputRequestDTO / screenResponse / toSessionDTO), so existing
// Go `clients/` can talk to the port unchanged.
//
// WIRE-COMPAT CONTRACT (honor exactly — Go clients depend on it):
//   • JSON field names are Go's snake_case, NOT MH's camelCase.
//   • `retry_after` is a Go-style DURATION STRING ("30s", "1m30s", "1.5s"),
//     even though MH's `Turn.retryAfter` (src/chat/types.ts) is a NUMBER of
//     milliseconds. `turnDTO` formats it via `goDurationString`; 0 is omitted
//     (matching Go's `if t.RetryAfter > 0`).
//   • Timestamps serialize as RFC3339/ISO strings (Date.toISOString()).
//     `completed_at` is omitted when the turn is not yet complete (Go's
//     `omitzero`); MH marks that with `new Date(0)` (the epoch).
//
// MH SUPERSET (additive; Go clients never send these, so Go compat holds):
//   • `inputRequestDTO` exposes `header` and `multi_select`, and each option
//     carries `description` — fields Go's narrower `inputRequestDTO` lacks.
//     Without them, multi-select prompts would be unreachable over HTTP.
//   • `parseAnswerRequest` accepts the MH-only `option_ids[]` (multi-select),
//     which takes precedence over `option_id` when non-empty.

import type {
  InputAnswer,
  InputOption,
  InputRequest,
  Session,
  Turn,
} from "../chat/types.ts";
import type { TurnResult } from "../harness/index.ts";
import type { Snapshot } from "../screen/screen.ts";

// ── Wire shapes ──────────────────────────────────────────────────────────────

/** Wire shape of a Turn. Field names + `retry_after` format match Go's turnDTO. */
export interface TurnDTO {
  id: string;
  session_id: string;
  role: string;
  state: string;
  text?: string;
  reason?: string;
  started_at: string;
  completed_at?: string;
  /** Upstream API status code; omitted when zero. */
  http_code?: number;
  /** Go duration string ("30s"); omitted when no backoff hint. */
  retry_after?: string;
}

/** Wire shape of one InputOption — includes the MH-only `description`. */
export interface InputOptionDTO {
  id: string;
  alias?: string;
  label: string;
  /** MH superset: explanatory text under the label, when present. */
  description?: string;
}

/** Wire shape of an InputRequest — the MH SUPERSET (adds header + multi_select). */
export interface InputRequestDTO {
  id: string;
  kind: string;
  prompt: string;
  options?: InputOptionDTO[];
  /** MH superset: the dialog header/tab label for "question" kinds. */
  header?: string;
  /** MH superset: true when the prompt accepts multiple selections. */
  multi_select?: boolean;
}

/** Rendered-terminal snapshot returned by GET .../screen. Mirrors Go screenResponse. */
export interface ScreenResponseDTO {
  text: string;
  cols: number;
  rows: number;
  cursor_col: number;
  cursor_row: number;
  generation: number;
}

/** Wire shape of a Session. Mirrors Go sessionDTO. */
export interface SessionDTO {
  id: string;
  harness: string;
  working_dir?: string;
  created_at: string;
  harness_session_id?: string;
}

/** Response body of POST .../conversations (open). Mirrors Go openResponse. */
export interface OpenResponseDTO {
  id: string;
}

/**
 * Response body of POST /v1/turns (one-shot RunTurn). Assembled from
 * `TurnResult`'s fields — there is no single turn-result converter in Go's
 * `types.go` (the daemon builds this inline), so MH defines it here beside the
 * other converters. Field names stay snake_case to match the rest of the wire
 * contract.
 */
export interface TurnResultDTO {
  /** The assistant turn that completed or errored. */
  turn: TurnDTO;
  /** The chat-level session record after the turn. */
  session: SessionDTO;
  /** conv.historyWithSource() after the turn (or the store fallback). */
  history: TurnDTO[];
  /** Which path produced `history`: "transcript" or "store". */
  history_source: string;
  /** True when runTurn intentionally stopped the harness after the turn. */
  process_stopped_after_turn: boolean;
}

/** One item of GET .../conversations (list). Mirrors Go conversationSummary. */
export interface ConversationSummaryDTO {
  id: string;
  harness: string;
  session_id?: string;
}

/** Parsed body of POST .../answer (the wire answerRequest, MH superset). */
export interface AnswerRequestBody {
  token?: string;
  request_id?: string;
  option_id?: string;
  /** MH superset: multi-select option ids; wins over option_id when non-empty. */
  option_ids?: string[];
  text?: string;
}

// ── Duration formatting ─────────────────────────────────────────────────────

// Port of Go's time.Duration.String() (time/format.go). Input is milliseconds
// (MH's Turn.retryAfter); output is the Go duration string a Go client expects.
// Trailing-zero trimming and the h/m/s decomposition match Go byte-for-byte for
// the whole-second backoffs harnesses emit ("30s", "1m30s", "2m0s", "1.5s").

/** fmtFrac: Go's trailing-zero-trimmed fractional part; returns [".frac", v/10^prec]. */
function fmtFrac(v: number, prec: number): [string, number] {
  let digits = "";
  let print = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10;
    print = print || digit !== 0;
    if (print) digits = String(digit) + digits;
    v = Math.floor(v / 10);
  }
  return [print ? "." + digits : "", v];
}

/** Format a millisecond count as a Go duration string (e.g. 30000 → "30s"). */
export function goDurationString(ms: number): string {
  let u = Math.round(ms * 1e6); // nanoseconds, as Go's Duration
  const neg = u < 0;
  if (neg) u = -u;
  if (u === 0) return "0s";

  const SECOND = 1_000_000_000;
  let out: string;
  if (u < SECOND) {
    // Sub-second: pick the smallest unit, like Go.
    let prec: number;
    let unit: string;
    if (u < 1_000) {
      prec = 0;
      unit = "ns";
    } else if (u < 1_000_000) {
      prec = 3;
      unit = "µs";
    } else {
      prec = 6;
      unit = "ms";
    }
    const [frac, v] = fmtFrac(u, prec);
    out = String(v) + frac + unit;
  } else {
    const [frac, rem] = fmtFrac(u, 9);
    u = rem;
    let s = String(u % 60) + frac + "s";
    u = Math.floor(u / 60);
    if (u > 0) {
      s = String(u % 60) + "m" + s;
      u = Math.floor(u / 60);
      if (u > 0) s = String(u) + "h" + s;
    }
    out = s;
  }
  return neg ? "-" + out : out;
}

// ── Converters ──────────────────────────────────────────────────────────────

/** Serialize a Date as RFC3339/ISO, treating the epoch (new Date(0)) as "zero". */
function isZeroDate(d: Date): boolean {
  return d.getTime() === 0;
}

/** turnDTO: MH Turn → wire JSON. Ported from Go's toTurnDTO. */
export function turnDTO(t: Turn): TurnDTO {
  const out: TurnDTO = {
    id: t.id,
    session_id: t.sessionID,
    role: t.role,
    state: t.state,
    started_at: t.startedAt.toISOString(),
  };
  if (t.text) out.text = t.text;
  if (t.reason) out.reason = t.reason;
  if (!isZeroDate(t.completedAt))
    out.completed_at = t.completedAt.toISOString();
  if (t.httpCode) out.http_code = t.httpCode;
  if (t.retryAfter > 0) out.retry_after = goDurationString(t.retryAfter);
  return out;
}

/** inputOptionDTO: MH InputOption → wire JSON, carrying the MH-only description. */
export function inputOptionDTO(o: InputOption): InputOptionDTO {
  const out: InputOptionDTO = { id: o.id, label: o.label };
  if (o.alias) out.alias = o.alias;
  if (o.description) out.description = o.description;
  return out;
}

/**
 * inputRequestDTO: MH InputRequest → wire JSON. EXPOSES THE SUPERSET — includes
 * `header` and `multi_select` and each option's `description`, unlike Go's
 * narrower converter. Omitting these would make multi-select unreachable.
 */
export function inputRequestDTO(r: InputRequest): InputRequestDTO {
  const out: InputRequestDTO = { id: r.id, kind: r.kind, prompt: r.prompt };
  if (r.options && r.options.length > 0) {
    out.options = r.options.map(inputOptionDTO);
  }
  if (r.header) out.header = r.header;
  if (r.multiSelect) out.multi_select = r.multiSelect;
  return out;
}

/** screenResponse: Screen Snapshot → wire JSON. Ported from Go's screenResponse. */
export function screenResponse(s: Snapshot): ScreenResponseDTO {
  return {
    text: s.text,
    cols: s.cols,
    rows: s.rows,
    cursor_col: s.cursorCol,
    cursor_row: s.cursorRow,
    generation: s.generation,
  };
}

/** sessionDTO: MH Session → wire JSON. Ported from Go's toSessionDTO. */
export function sessionDTO(s: Session): SessionDTO {
  const out: SessionDTO = {
    id: s.id,
    harness: s.harness,
    created_at: s.createdAt.toISOString(),
  };
  if (s.workingDir) out.working_dir = s.workingDir;
  if (s.harnessSessionID) out.harness_session_id = s.harnessSessionID;
  return out;
}

/** openResponse: the POST /conversations reply. `id` is the conversation id. */
export function openResponse(id: string): OpenResponseDTO {
  return { id };
}

/** turnResultDTO: MH TurnResult → wire JSON. Assembles the POST /v1/turns body. */
export function turnResultDTO(r: TurnResult): TurnResultDTO {
  return {
    turn: turnDTO(r.turn),
    session: sessionDTO(r.session),
    history: r.history.map(turnDTO),
    history_source: r.historySource,
    process_stopped_after_turn: r.processStoppedAfterTurn,
  };
}

/**
 * conversationSummary: one GET /conversations list item. Per the id-convention,
 * `session_id` carries Conversation.sessionID().
 */
export function conversationSummary(
  id: string,
  harness: string,
  sessionID: string,
): ConversationSummaryDTO {
  const out: ConversationSummaryDTO = { id, harness };
  if (sessionID) out.session_id = sessionID;
  return out;
}

/**
 * parseAnswerRequest: wire answerRequest → MH InputAnswer. Supports `option_id`
 * → optionID, `text` → text, and the MH-only `option_ids[]` → optionIDs. Per the
 * superset contract, a non-empty `option_ids` takes precedence over `option_id`.
 */
export function parseAnswerRequest(body: AnswerRequestBody): InputAnswer {
  const out: InputAnswer = {};
  if (Array.isArray(body.option_ids) && body.option_ids.length > 0) {
    out.optionIDs = body.option_ids;
  }
  if (body.option_id) out.optionID = body.option_id;
  if (body.text !== undefined) out.text = body.text;
  return out;
}
