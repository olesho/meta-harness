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