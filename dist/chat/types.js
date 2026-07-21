// Chat-level data types — the TS port of pkg/chat's value types (chat.go,
// input.go, store.go). Pure data + the Store interface; no runtime behavior
// beyond newID.
export const RoleUser = "user";
export const RoleAssistant = "assistant";
export const RoleSystem = "system";
export const TurnStatePending = "pending";
export const TurnStateStreaming = "streaming";
export const TurnStateComplete = "complete";
export const TurnStateErrored = "errored";
/**
 * Canonical `Turn.reason` recorded when a turn produced no assistant output
 * because the harness CLI is logged out / its login has expired (claude-code
 * "Not logged in · Please run /login"; codex "401 Unauthorized" / "Not logged
 * in"). The stable `auth_required:` prefix is a machine token consumers match to
 * tell "renew the harness login" apart from a genuine task failure — instead of
 * re-scraping the rendered screen themselves. Set only at a turn's terminal
 * point when no clean reply was recoverable (see Conversation).
 */
export const ReasonAuthRequired = "auth_required: harness login expired or re-authentication required — renew the harness login";
/**
 * Terminal-turn `reason` set when the harness produced no assistant reply because
 * its subscription usage/session window is exhausted — claude-code renders a wall
 * ("You've hit your session limit · resets 10:20pm …") in place of a reply. Like
 * {@link ReasonAuthRequired} the stable `usage_limit:` prefix is a machine token
 * consumers match to tell a TRANSIENT quota outage (retry once the window resets)
 * apart from a genuine task failure — so the orchestrator can reopen the task
 * blamelessly instead of counting it toward a runaway/block guard. The specific
 * reset time rides along in a trailing "(…)" detail. Set only at a turn's terminal
 * point when the "reply" was in fact the wall (see Conversation.usageLimitRelabel).
 */
export const ReasonUsageLimited = "usage_limit: harness usage or session limit reached — retry after the quota window resets";
export const EventTurn = "turn";
export const EventInputRequest = "input_request";
export const EventInputResolved = "input_resolved";
export const DispositionAsk = "ask";
export const DispositionAnswer = "answer";
export const DispositionDeny = "deny";
export const HistorySourceTranscript = "transcript";
export const HistorySourceStore = "store";
/** newID returns a fresh 16-byte hex ID. */
export function newID() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    let s = "";
    for (const x of b)
        s += x.toString(16).padStart(2, "0");
    return s;
}
//# sourceMappingURL=types.js.map