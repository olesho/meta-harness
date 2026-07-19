import type { InputAnswer, InputOption, InputRequest, Session, Turn } from "../chat/types.ts";
import type { TurnResult } from "../harness/index.ts";
import type { Snapshot } from "../screen/screen.ts";
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
/** Format a millisecond count as a Go duration string (e.g. 30000 → "30s"). */
export declare function goDurationString(ms: number): string;
/** turnDTO: MH Turn → wire JSON. Ported from Go's toTurnDTO. */
export declare function turnDTO(t: Turn): TurnDTO;
/** inputOptionDTO: MH InputOption → wire JSON, carrying the MH-only description. */
export declare function inputOptionDTO(o: InputOption): InputOptionDTO;
/**
 * inputRequestDTO: MH InputRequest → wire JSON. EXPOSES THE SUPERSET — includes
 * `header` and `multi_select` and each option's `description`, unlike Go's
 * narrower converter. Omitting these would make multi-select unreachable.
 */
export declare function inputRequestDTO(r: InputRequest): InputRequestDTO;
/** screenResponse: Screen Snapshot → wire JSON. Ported from Go's screenResponse. */
export declare function screenResponse(s: Snapshot): ScreenResponseDTO;
/** sessionDTO: MH Session → wire JSON. Ported from Go's toSessionDTO. */
export declare function sessionDTO(s: Session): SessionDTO;
/** openResponse: the POST /conversations reply. `id` is the conversation id. */
export declare function openResponse(id: string): OpenResponseDTO;
/** turnResultDTO: MH TurnResult → wire JSON. Assembles the POST /v1/turns body. */
export declare function turnResultDTO(r: TurnResult): TurnResultDTO;
/**
 * conversationSummary: one GET /conversations list item. Per the id-convention,
 * `session_id` carries Conversation.sessionID().
 */
export declare function conversationSummary(id: string, harness: string, sessionID: string): ConversationSummaryDTO;
/**
 * parseAnswerRequest: wire answerRequest → MH InputAnswer. Supports `option_id`
 * → optionID, `text` → text, and the MH-only `option_ids[]` → optionIDs. Per the
 * superset contract, a non-empty `option_ids` takes precedence over `option_id`.
 */
export declare function parseAnswerRequest(body: AnswerRequestBody): InputAnswer;
//# sourceMappingURL=dto.d.ts.map