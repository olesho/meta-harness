// classifyFinishedOutput — classification for a harness that has ALREADY EXITED.
//
// Port of harness-wrapper's pkg/wrapper/finished.go (PR #64), including its two
// incident fixes: #68 ("a timestamp is not a status code") and #69 ("a residual
// row may only match text that names an API failure").
//
// It runs the same classifier classifyOutput does, then a residual fallback for
// the signals the per-harness anchored matchers miss. classifyOutput stays the
// plain one-shot: same classifier, no fallback, unchanged for every caller. The
// split exists because the residual rows are the broadest patterns in the
// library, and sharing them with the live polling dispatcher would let an agent
// that merely PRINTS such a word terminate its own healthy process. Post-exit
// there is no process left to terminate, so breadth costs a misclassification
// at worst.
//
// Regex translation from Go RE2. Three differences are handled on purpose:
//   - Go's inline (?i) is not JS syntax; every pattern uses the `i` flag.
//   - Go's `.` excludes only "\n"; JS's also excludes "\r", which PTY output is
//     full of. Every `.` is written `[^\n]` so matches span exactly what Go's do.
//   - Go's `\s` is ASCII [\t\n\f\r ]; JS's is Unicode-wide. Written out.
import { classifyOutput } from "./classifier.js";
import { noClassification } from "./classification.js";
import { ErrAuth, ErrBilling, ErrContextOverflow, ErrModelNotFound, ErrNone, ErrRateLimited, ErrTimeout, ErrTransient, ErrUnknown, } from "./errorclass.js";
import { StatusBinaryNotFound } from "./status.js";
/**
 * The `rule` stamped on an ErrTransient result that classifyFinishedOutput
 * refined to ErrTimeout. The "wrapper/" prefix is not a package name: it is the
 * id loom already records for this rewrite in its evidence log, so it must not
 * change.
 */
export const RuleTimeoutUpgrade = "wrapper/timeout_upgrade";
const WS = "[\\t\\n\\f\\r ]";
const ANY = "[^\\n]";
/** Timeout wording anywhere in the output (the ErrTransient refinement). */
const finishedTimeoutRe = new RegExp(`\\btimeout\\b|etimedout|connection${ANY}?timed?${ANY}?out|timed?${ANY}?out|deadline${ANY}?exceeded`, "i");
/**
 * A credential VARIABLE NAME, only when a failure word keeps it company on the
 * same line. `reading ANTHROPIC_API_KEY from the environment` — an agent
 * narrating its own work — once fatally stopped that agent; `Error:
 * OPENAI_API_KEY is not set` is a real failure and must keep classifying. Both
 * orders, line-scoped and bounded.
 */
const apiKeyVarUnset = `(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|CURSOR)_API_KEY[^\\n]{0,40}?(?:not set|unset|missing|required|invalid|empty)` +
    `|(?:not set|unset|missing|required|invalid|empty)[^\\n]{0,40}?(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|CURSOR)_API_KEY`;
const row = (id, src, cls, reason) => ({
    id,
    re: new RegExp(src, "gi"),
    cls,
    reason,
});
/**
 * The backend-agnostic fallback table, consulted only by classifyFinishedOutput
 * and only when the resolved classifier returned nothing actionable. Ordered
 * RateLimited-first, Transient-last: the order IS the precedence, so text naming
 * both a quota and a 500 is a rate limit, the verdict that recovers on its own.
 *
 * A row may only match text that NAMES AN API FAILURE. Measured before
 * narrowing, 10 of 12 ordinary outputs produced a fatal verdict — a filesystem
 * `permission denied`, an `ANTHROPIC_API_KEY` mentioned in passing, `billing` in
 * a filename. Removed for that reason: bare permission-denied, invalid.*key,
 * bare *_API_KEY, \bbilling\b, \bquota\b, \bcredits\b, too.?long. A genuine wall
 * is now named by the harness itself (see chat/apierror.ts), so these rows no
 * longer have to guess at one.
 */
const residualRows = [
    row("residual.ratelimit", `\\b429\\b|too many requests|tokens per min|overloaded_error|resource${ANY}?exhausted|resource_exhausted|rate${ANY}?limit|usage${ANY}?limit|session${ANY}?limit|resets at|resets \\d{1,2}:\\d{2}|try again at${WS}+\\d`, ErrRateLimited, "rate limit exceeded"),
    row("residual.auth", `\\b401\\b|unauthorized|unauthenticated|forbidden|invalid${ANY}?api${ANY}?key|incorrect${ANY}?api${ANY}?key|authentication${ANY}?failed|` +
        apiKeyVarUnset, ErrAuth, "authentication failed"),
    row("residual.billing", `\\b402\\b|payment${ANY}?required|insufficient${ANY}?(?:credits|quota)|insufficient_quota|exceeded${ANY}*quota|quota${ANY}?exceeded`, ErrBilling, "billing error"),
    row("residual.model_version", `model requires a newer version|requires a newer version of (?:codex|claude)|upgrade to the latest (?:app or )?cli`, ErrModelNotFound, "backend CLI is incompatible with the selected model"),
    row("residual.model_not_found", `model${ANY}?not${ANY}?found|model${ANY}*not found|model${ANY}*does not exist|model${ANY}*not${ANY}*exist|model_not_found|unsupported${ANY}?model|unknown${ANY}?model|invalid${ANY}?model|selected model${ANY}*may not exist|selected model${ANY}*may not have access to it|\\b404\\b${ANY}*model`, ErrModelNotFound, "model not found"),
    row("residual.context", `context${ANY}?length|context${ANY}?window|context_length_exceeded|maximum context length|max${ANY}?tokens|max${ANY}*tokens|token${ANY}?limit|prompt${ANY}?too${ANY}?long`, ErrContextOverflow, "context length exceeded"),
    row("residual.timeout", `\\btimeout\\b|etimedout|connection${ANY}?timed?${ANY}?out|timed?${ANY}?out|deadline${ANY}?exceeded`, ErrTimeout, "connection timeout"),
    row("residual.transient", `\\b50[023]\\b|\\b529\\b|server${ANY}?error|server_error|internal${ANY}?server${ANY}?error|internal${ANY}?error|service${ANY}?unavailable|backend${ANY}?error|overloaded`, ErrTransient, "server error"),
];
/**
 * classifyFinishedOutput classifies the output of a harness that has already
 * exited. Order:
 *  1. the resolved classifier, exactly as classifyOutput runs it;
 *  2. an actionable result is returned unchanged — including binary_not_found,
 *     which is a statement about the launch, not the output;
 *  3. only on ErrNone / ErrUnknown are the residual rows consulted, and a hit
 *     REPLACES the result;
 *  4. an ErrTransient result whose surrounding text names a timeout becomes
 *     ErrTimeout (its own backoff bucket downstream);
 *  5. a rate-limited result with no wait hint gets one from a Retry-After token
 *     anywhere in the output.
 * Returns the classifier's own result when nothing matches, so a caller's
 * exit-code fallback still applies.
 */
export function classifyFinishedOutput(harness, output) {
    const c = classifyOutput(harness, output);
    if (c.status === StatusBinaryNotFound)
        return c;
    switch (c.class) {
        case ErrNone:
        case ErrUnknown: {
            const r = matchResidual(output);
            if (r !== null)
                return r;
            break;
        }
        case ErrTransient: {
            const m = finishedTimeoutRe.exec(output);
            if (m !== null)
                return {
                    ...c,
                    class: ErrTimeout,
                    rule: RuleTimeoutUpgrade,
                    match: m[0],
                };
            break;
        }
        case ErrRateLimited:
            if (c.retryAfter === 0)
                return { ...c, retryAfter: parseRetryAfterMs(output) };
            break;
    }
    return c;
}
/**
 * Runs the residual rows in order and builds a FRESH Classification for the
 * first usable hit — never inheriting status, httpCode or resumeAt from the
 * result it replaces. A residual row is a text fingerprint, not a lifecycle
 * state: status stays empty and `rule` is what a caller discriminates on.
 */
function matchResidual(output) {
    if (output === "")
        return null;
    for (const r of residualRows) {
        const hit = firstUsableMatch(r.re, output);
        if (hit === null)
            continue;
        return {
            ...noClassification(),
            class: r.cls,
            reason: r.reason,
            rule: r.id,
            match: hit,
            retryAfter: r.cls === ErrRateLimited ? parseRetryAfterMs(output) : 0,
        };
    }
    return null;
}
/**
 * The first match of `re` in `s` that is not embeddedNumber, or null. Walks ALL
 * matches, because the digits that fool us come first: a log tail opens with its
 * timestamp and the real error arrives at the end. Matches the WHOLE string —
 * re-matching a slice would move the \b anchors.
 */
function firstUsableMatch(re, s) {
    for (const m of s.matchAll(re)) {
        const lo = m.index;
        const hi = lo + m[0].length;
        if (!embeddedNumber(s, lo, hi))
            return m[0];
    }
    return null;
}
const isDigit = (code) => code >= 0x30 && code <= 0x39;
/**
 * Whether an all-digit match at [lo,hi) is a fragment of a larger number rather
 * than a status code standing on its own.
 *
 * A measured incident (2026-09-11): a loom agent's log tail began
 * `time=2026-09-11T17:08:17.402+02:00`; residual.billing's \b402\b matched the
 * MILLISECOND FIELD, the turn was classified ErrBilling, the agent was stopped
 * fatally and an account-wide wall parked five more agents for fifteen minutes.
 * The same hazard covers 7 of the 10 ordinary millisecond values, two of them
 * fatal (.401 -> ErrAuth, .402 -> ErrBilling). A match preceded by '.', or
 * followed by '.' and a digit, is part of a number (a millisecond field, a
 * version, a decimal) and says nothing about HTTP.
 */
function embeddedNumber(s, lo, hi) {
    for (let i = lo; i < hi; i++) {
        if (!isDigit(s.charCodeAt(i)))
            return false; // a word row: unaffected
    }
    if (lo > 0 && s[lo - 1] === ".")
        return true;
    if (hi + 1 < s.length && s[hi] === "." && isDigit(s.charCodeAt(hi + 1)))
        return true;
    return false;
}
const retryAfterRe = new RegExp(`retry${ANY}?after[:\\t\\n\\f\\r ]+(\\d+)`, "i");
/** A "retry-after: N" value (seconds) from text, in milliseconds; 0 when absent. */
function parseRetryAfterMs(text) {
    const m = retryAfterRe.exec(text);
    if (m === null)
        return 0;
    const secs = Number.parseInt(m[1], 10);
    return Number.isFinite(secs) ? secs * 1000 : 0;
}
//# sourceMappingURL=finished.js.map