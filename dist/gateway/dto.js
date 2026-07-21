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
// ── Duration formatting ─────────────────────────────────────────────────────
// Port of Go's time.Duration.String() (time/format.go). Input is milliseconds
// (MH's Turn.retryAfter); output is the Go duration string a Go client expects.
// Trailing-zero trimming and the h/m/s decomposition match Go byte-for-byte for
// the whole-second backoffs harnesses emit ("30s", "1m30s", "2m0s", "1.5s").
/** fmtFrac: Go's trailing-zero-trimmed fractional part; returns [".frac", v/10^prec]. */
function fmtFrac(v, prec) {
    let digits = "";
    let print = false;
    for (let i = 0; i < prec; i++) {
        const digit = v % 10;
        print = print || digit !== 0;
        if (print)
            digits = String(digit) + digits;
        v = Math.floor(v / 10);
    }
    return [print ? "." + digits : "", v];
}
/** Format a millisecond count as a Go duration string (e.g. 30000 → "30s"). */
export function goDurationString(ms) {
    let u = Math.round(ms * 1e6); // nanoseconds, as Go's Duration
    const neg = u < 0;
    if (neg)
        u = -u;
    if (u === 0)
        return "0s";
    const SECOND = 1_000_000_000;
    let out;
    if (u < SECOND) {
        // Sub-second: pick the smallest unit, like Go.
        let prec;
        let unit;
        if (u < 1_000) {
            prec = 0;
            unit = "ns";
        }
        else if (u < 1_000_000) {
            prec = 3;
            unit = "µs";
        }
        else {
            prec = 6;
            unit = "ms";
        }
        const [frac, v] = fmtFrac(u, prec);
        out = String(v) + frac + unit;
    }
    else {
        const [frac, rem] = fmtFrac(u, 9);
        u = rem;
        let s = String(u % 60) + frac + "s";
        u = Math.floor(u / 60);
        if (u > 0) {
            s = String(u % 60) + "m" + s;
            u = Math.floor(u / 60);
            if (u > 0)
                s = String(u) + "h" + s;
        }
        out = s;
    }
    return neg ? "-" + out : out;
}
// ── Converters ──────────────────────────────────────────────────────────────
/** Serialize a Date as RFC3339/ISO, treating the epoch (new Date(0)) as "zero". */
function isZeroDate(d) {
    return d.getTime() === 0;
}
/** turnDTO: MH Turn → wire JSON. Ported from Go's toTurnDTO. */
export function turnDTO(t) {
    const out = {
        id: t.id,
        session_id: t.sessionID,
        role: t.role,
        state: t.state,
        started_at: t.startedAt.toISOString(),
    };
    if (t.text)
        out.text = t.text;
    if (t.reason)
        out.reason = t.reason;
    if (!isZeroDate(t.completedAt))
        out.completed_at = t.completedAt.toISOString();
    if (t.httpCode)
        out.http_code = t.httpCode;
    if (t.retryAfter > 0)
        out.retry_after = goDurationString(t.retryAfter);
    return out;
}
/** inputOptionDTO: MH InputOption → wire JSON, carrying the MH-only description. */
export function inputOptionDTO(o) {
    const out = { id: o.id, label: o.label };
    if (o.alias)
        out.alias = o.alias;
    if (o.description)
        out.description = o.description;
    return out;
}
/**
 * inputRequestDTO: MH InputRequest → wire JSON. EXPOSES THE SUPERSET — includes
 * `header` and `multi_select` and each option's `description`, unlike Go's
 * narrower converter. Omitting these would make multi-select unreachable.
 */
export function inputRequestDTO(r) {
    const out = { id: r.id, kind: r.kind, prompt: r.prompt };
    if (r.options && r.options.length > 0) {
        out.options = r.options.map(inputOptionDTO);
    }
    if (r.header)
        out.header = r.header;
    if (r.multiSelect)
        out.multi_select = r.multiSelect;
    return out;
}
/** screenResponse: Screen Snapshot → wire JSON. Ported from Go's screenResponse. */
export function screenResponse(s) {
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
export function sessionDTO(s) {
    const out = {
        id: s.id,
        harness: s.harness,
        created_at: s.createdAt.toISOString(),
    };
    if (s.workingDir)
        out.working_dir = s.workingDir;
    if (s.harnessSessionID)
        out.harness_session_id = s.harnessSessionID;
    return out;
}
/** openResponse: the POST /conversations reply. `id` is the conversation id. */
export function openResponse(id) {
    return { id };
}
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
export function turnResultDTO(r) {
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
export function conversationSummary(id, harness, sessionID) {
    const out = { id, harness };
    if (sessionID)
        out.session_id = sessionID;
    return out;
}
/**
 * parseAnswerRequest: wire answerRequest → MH InputAnswer. Supports `option_id`
 * → optionID, `text` → text, and the MH-only `option_ids[]` → optionIDs. Per the
 * superset contract, a non-empty `option_ids` takes precedence over `option_id`.
 */
export function parseAnswerRequest(body) {
    const out = {};
    if (Array.isArray(body.option_ids) && body.option_ids.length > 0) {
        out.optionIDs = body.option_ids;
    }
    if (body.option_id)
        out.optionID = body.option_id;
    if (body.text !== undefined)
        out.text = body.text;
    return out;
}
//# sourceMappingURL=dto.js.map