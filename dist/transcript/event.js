// Canonical, harness-agnostic transcript event model — the TS port of
// harness-wrapper's pkg/transcript event.go. Per-harness readers translate
// native formats into Event[] so consumers handle one shape.
import { createHash } from "node:crypto";
// SchemaVersion is the current canonical Event wire-schema version. Bump only
// on a breaking change; add fields additively otherwise.
export const SchemaVersion = 1;
// Canonical role constants.
export const RoleUser = "user";
export const RoleAssistant = "assistant";
export const RoleTool = "tool";
export const RoleSystem = "system";
// Canonical event type constants (the public Type values).
export const EventText = "text";
export const EventToolUse = "tool_use";
export const EventToolResult = "tool_result";
export const EventSessionMeta = "session_meta";
// Event provenance (Source) — which acquisition produced the event.
export const SourceLive = "live";
export const SourceFile = "file";
// SourceHook tags events sourced from a harness hook stream. It is the SECOND
// actually-emitted provenance (after SourceFile) — NOT a third among three live
// producers: SourceLive remains an unproduced (dead) constant, assigned nowhere
// in src/. Hook events feed the eventID-based dedup consumer in hookMerge.ts,
// where they collapse against the authoritative SourceFile event.
export const SourceHook = "hook";
// unixNanoStr renders a timestamp the way Go's Timestamp.UnixNano() feeds the
// content hash. Exact value is unimportant — only stability matters.
function unixNanoStr(ts) {
    if (!ts)
        return "0";
    return `${ts.getTime()}000000`;
}
// eventID returns the stable dedup identity for the event. Identity is
// PARSER-OWNED: a kind-qualified nativeID wins. Falling back to a content hash
// (which must be cross-source-stable) excludes seq and arrival time.
export function eventID(e) {
    if (e.nativeID)
        return e.nativeID;
    if (e.uuid)
        return "msg:" + e.uuid;
    if (e.toolUseID) {
        // Kind-qualified so a tool-use and its tool-result never collapse.
        return (e.type ?? "") + ":" + e.toolUseID;
    }
    const h = createHash("sha256");
    h.update([
        e.type ?? "",
        e.role ?? "",
        unixNanoStr(e.timestamp),
        e.text ?? "",
        e.toolInput ?? "",
        e.output ?? "",
    ].join("\x00"));
    return "h:" + h.digest("hex").slice(0, 32);
}
// turnsFromEvents projects canonical Events down to the chat Turn view.
// Tool-only events without renderable text are dropped.
export function turnsFromEvents(events) {
    const out = [];
    for (const e of events) {
        if (!e.text)
            continue;
        out.push({ role: e.role || RoleSystem, text: e.text, timestamp: e.timestamp });
    }
    return out;
}
// envelope stamps run-level identity onto a ParsedEvent.
export function envelope(pe, runID, harness) {
    return {
        runID,
        harness,
        harnessSessionID: pe.harnessSessionID,
        parentSessionID: pe.parentSessionID,
        event: pe.event,
    };
}
// toPublicJSON renders the byte-identical Runs-tab DTO: PUBLIC fields only, with
// the internal source/nativeID/schemaVersion omitted (the analogue of Event's
// public json tags). Empty optional fields are dropped (json:"...,omitempty").
export function toPublicJSON(e) {
    const o = {
        seq: e.seq ?? 0,
        timestamp: (e.timestamp ?? new Date(0)).toISOString(),
        role: e.role ?? "",
        type: e.type ?? "",
    };
    if (e.text)
        o.text = e.text;
    if (e.toolName)
        o.tool_name = e.toolName;
    if (e.toolUseID)
        o.tool_use_id = e.toolUseID;
    if (e.toolInput)
        o.tool_input = JSON.parse(e.toolInput);
    if (e.output)
        o.output = e.output;
    if (e.uuid)
        o.uuid = e.uuid;
    return o;
}
//# sourceMappingURL=event.js.map