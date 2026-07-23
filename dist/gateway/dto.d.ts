import type { InputAnswer, InputOption, InputRequest, Session, Turn } from "../chat/types.ts";
import type { PermissionModeReading, PermissionModeSource, PermissionRung } from "../chat/permission.ts";
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
/**
 * Wire shape of GET .../permission-mode. MH-ONLY — there is no Go counterpart,
 * so nothing in `test/corpus/wire/` constrains it.
 *
 * CASING IS DELIBERATELY MIXED, and only the KEYS follow the file's snake_case
 * rule. The VALUES are each vocabulary's own spelling, verbatim:
 *   • `requested` / `observed` carry `PermissionRung` — camelCase
 *     (`"acceptEdits"`), so they round-trip back through
 *     `normalizePermissionRung` unchanged.
 *   • `source` carries `PermissionModeSource` — snake_case
 *     (`"written_uncaptured"`, `"too_narrow"`), the prime-outcome vocabulary.
 * Do not "fix" either one into the other; a rewritten value breaks a consumer
 * that compares it against the TS enum it came from.
 *
 * `requested`, `requested_raw`, `raw` and `collaboration` are OMITTED when
 * empty (the style `sessionDTO` uses for `working_dir`). The omission carries
 * meaning: `observed: "unknown"` WITH a `raw` is "the session is outside the
 * ladder" (a renamed mode, `Workspace (Approve for me)`); `observed: "unknown"`
 * with NO `raw` is "we could not see", and `source` says why.
 */
export interface PermissionModeResponseDTO {
    /** The launch-requested rung, normalized; omitted when none was requested. */
    requested?: PermissionRung;
    /** The caller's verbatim launch spelling (e.g. "bypassPermissions"); omitted when empty. */
    requested_raw?: string;
    /** The rung the screen reports, or "unknown". */
    observed: PermissionRung | "unknown";
    /** The screen fragment `observed` came from; omitted when nothing was seen. */
    raw?: string;
    /** The codex collaboration axis; omitted when the harness has no such axis. */
    collaboration?: "default" | "plan" | "unknown";
    /** Why `observed` says what it says. */
    source: PermissionModeSource;
    /** The screen generation the reading was parsed from. */
    generation: number;
    /** The generation of the snapshot the handler measured. */
    current_generation: number;
    /**
     * `current_generation !== generation` — A GENERATION COMPARISON, NOT A
     * LIVENESS CLAIM. It says "the frame this reading was parsed from is not the
     * frame you are being told about", nothing more. A live claude footer read is
     * always `false` (it parsed the very frame the handler measured); a
     * startup-cached codex `/status` box flips to `true` the moment anything has
     * been drawn since. A CLOSED conversation also reports `false` — nothing
     * writes after close, so the frozen frame trivially matches itself; callers
     * distinguish that case with the conversation's own closed state, never with
     * `stale`.
     */
    stale: boolean;
    /** When the reading was taken (RFC3339). */
    observed_at: string;
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
    /**
     * Error string for an errored turn (Go's runTurnResponse.Error, omitempty).
     * Left off entirely on a completed turn; set by the /v1/turns handler's
     * errored-turn branch to the caught RunTurnError's message.
     */
    error?: string;
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
/**
 * permissionModeResponse: a PermissionModeReading + the generation of the frame
 * the handler measured → wire JSON.
 *
 * `currentGeneration` MUST come from the SAME snapshot the reading was taken
 * from (`conv.permissionMode(snap)` / `snap.generation`). Sampling the screen
 * twice would let a byte arriving in between bump the generation and report
 * `stale: true` on a genuinely live read.
 *
 * See PermissionModeResponseDTO for the casing contract (keys snake_case,
 * values verbatim from their own vocabulary) and for what `stale` does and does
 * not mean.
 */
export declare function permissionModeResponse(r: PermissionModeReading, currentGeneration: number): PermissionModeResponseDTO;
/** sessionDTO: MH Session → wire JSON. Ported from Go's toSessionDTO. */
export declare function sessionDTO(s: Session): SessionDTO;
/** openResponse: the POST /conversations reply. `id` is the conversation id. */
export declare function openResponse(id: string): OpenResponseDTO;
/**
 * turnResultDTO: MH TurnResult → wire JSON. Assembles the POST /v1/turns body.
 *
 * Conformance vs Go's runTurnResponse (the shared corpus, META-HARNESS-91 /
 * HARNESS-WRAPPER-47, owns the golden diff — these are the recorded expectations):
 *   - `error` (omitempty) is set only by the handler's errored-turn branch, never
 *     here — a completed turn omits it, matching Go.
 *   - `wrapper_status` / `wrapper_reason` (omitempty in Go) are OMITTED: this
 *     Conversation/wrapper surface exposes no per-turn wrapper Result to populate
 *     them (see runTurn.ts). Absent-vs-empty is a benign superset gap.
 *   - `history_source` is an MH-only field (no Go counterpart); the corpus must
 *     tolerate it as an MH superset.
 */
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