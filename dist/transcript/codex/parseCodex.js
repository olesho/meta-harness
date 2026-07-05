// Codex rollout JSONL → canonical, TOOL-AWARE Event parser. Ported from
// harness-wrapper's parse_codex.go. Each Event is tagged source=file with a
// dedup-stable, kind-qualified nativeID.
import { EventText, EventToolResult, EventToolUse, RoleAssistant, RoleSystem, RoleTool, RoleUser, SourceFile, } from "../event.js";
import { stripIDEContextTags } from "../stripTags.js";
// parseRollout reads Codex rollout JSONL into envelope lines. Malformed lines
// are skipped.
export function parseRollout(data) {
    const out = [];
    for (const line of data.split("\n")) {
        if (line.length === 0)
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // skip malformed
        }
    }
    return out;
}
// events parses Codex rollout JSONL into the canonical, tool-aware event stream.
// Only response_item entries are surfaced.
export function events(data) {
    const envelopes = parseRollout(data);
    const out = [];
    let seq = 0;
    for (const env of envelopes) {
        if (env.type !== "response_item")
            continue;
        const ts = parseCodexTime(env.timestamp);
        let item;
        try {
            item = env.payload;
        }
        catch {
            continue;
        }
        if (!item || typeof item !== "object")
            continue;
        switch (item.type) {
            case "message":
                seq = appendMessageEvents(out, item, ts, seq);
                break;
            case "function_call":
                out.push({
                    seq,
                    timestamp: ts,
                    role: RoleAssistant,
                    type: EventToolUse,
                    toolName: item.name,
                    toolUseID: item.call_id,
                    toolInput: item.arguments,
                    source: SourceFile,
                    nativeID: "tool-use:" + (item.call_id ?? ""),
                });
                seq++;
                break;
            case "function_call_output":
                out.push({
                    seq,
                    timestamp: ts,
                    role: RoleTool,
                    type: EventToolResult,
                    toolUseID: item.call_id,
                    output: decodeFunctionOutput(item.output),
                    source: SourceFile,
                    nativeID: "tool-result:" + (item.call_id ?? ""),
                });
                seq++;
                break;
        }
    }
    return out;
}
// appendMessageEvents emits one text event per non-empty content block (user
// text has IDE/system context tags stripped).
function appendMessageEvents(out, item, ts, seq) {
    const role = canonicalRole(item.role ?? "");
    for (const block of item.content ?? []) {
        let text = block.text ?? "";
        if (role === RoleUser)
            text = stripIDEContextTags(text);
        if (text === "")
            continue;
        out.push({
            seq,
            timestamp: ts,
            role,
            type: EventText,
            text,
            source: SourceFile,
            nativeID: SourceFile + ":text:" + seq,
        });
        seq++;
    }
    return seq;
}
// decodeFunctionOutput pulls the text out of a function_call_output payload,
// usually a JSON string and occasionally a structured object.
function decodeFunctionOutput(raw) {
    if (typeof raw === "string")
        return raw;
    if (raw === undefined || raw === null)
        return "";
    return JSON.stringify(raw);
}
function canonicalRole(r) {
    switch (r) {
        case "user":
            return RoleUser;
        case "assistant":
            return RoleAssistant;
        default:
            return RoleSystem;
    }
}
function parseCodexTime(s) {
    if (!s)
        return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
//# sourceMappingURL=parseCodex.js.map