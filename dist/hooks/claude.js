// Claude Code concrete hook provider. Parses Claude's native hook payloads —
// Stop / SessionStart / SubagentStop / PostToolUse (PostTask) — into canonical
// transcript Events stamped source=SourceHook. Ported by behavior from
// harness-wrapper's pkg/harness/claude/{hooks,hookinstall}.go.
//
// These payloads are primarily LIFECYCLE/session signals, so they emit as their
// own event kinds (session_meta / turn-boundary markers) rather than as
// per-message text duplicates of the SourceFile transcript — there is generally
// nothing to dedup against. Where a payload carries message text it is tagged
// SourceHook and treated as PROVISIONAL: we do NOT try to match file text
// identity (see hookMerge.ts's text rule), so the authoritative SourceFile text
// event supersedes it downstream.
import path from "node:path";
import { EventSessionMeta, EventText, RoleAssistant, RoleSystem, SourceHook, } from "../transcript/event.js";
import { encodedCWD } from "../transcript/claudecode/claudecode.js";
import { guardPath, sessionMatches } from "./guard.js";
import { specFromProfile, } from "./provider.js";
// Native Claude hook event names we recognize. "PostTask" is accepted as an
// alias for the Task-tool PostToolUse payload.
export const HookEventStop = "Stop";
export const HookEventSessionStart = "SessionStart";
export const HookEventSubagentStop = "SubagentStop";
export const HookEventPostToolUse = "PostToolUse";
export const HookEventPostTask = "PostTask";
// EventTurnBoundary is the canonical Event.type stamped on the lifecycle
// markers hook payloads emit (turn / subagent / task boundaries). SessionStart
// instead reuses the shared EventSessionMeta kind.
export const EventTurnBoundary = "turn_boundary";
// claudeHookOwner tags hook entries this provider installs so foreign entries
// in the same settings.json are never clobbered.
export const claudeHookOwner = "harness/claude";
// claudeStaticProfile is the fixed set of hook entries the Claude provider
// installs. The lifecycle events all shell out to the harness's yield command;
// the yield entry is the one the runtime drains.
const claudeStaticProfile = {
    owner: claudeHookOwner,
    entries: [
        { event: HookEventSessionStart, command: "harness hook yield" },
        { event: HookEventStop, command: "harness hook yield" },
        { event: HookEventSubagentStop, command: "harness hook yield" },
        {
            event: HookEventPostToolUse,
            command: "harness hook yield",
            matcher: "Task",
        },
    ],
    yield: { event: HookEventStop, command: "harness hook yield" },
};
// claudeSettingsPath returns the settings.json a Claude hook config lives in.
function claudeSettingsPath(ctx) {
    const dir = ctx.configDir !== "" ? ctx.configDir : path.join(ctx.home, ".claude");
    return path.join(dir, "settings.json");
}
// validateTranscriptPath confirms a payload's transcript_path lives under the
// Claude projects dir for ctx.cwd, using Claude's OWN directory-name encoding
// (encodedCWD) — never re-derived here. Returns the canonical path, or null on
// a traversal / out-of-bounds path (or when no cwd/path is available).
function validateTranscriptPath(ctx, transcriptPath) {
    if (!transcriptPath || ctx.cwd === "")
        return null;
    const projectDir = path.join(ctx.home, ".claude", "projects", encodedCWD(ctx.cwd));
    return guardPath(projectDir, transcriptPath);
}
// marker builds a lifecycle marker Event tagged SourceHook. nativeID is
// hook-owned and kind-qualified so distinct markers never collapse and so it
// never collides with a SourceFile event's id.
function marker(type, role, text, sessionID, detail) {
    return {
        role,
        type,
        text,
        source: SourceHook,
        nativeID: `hook:${type}:${sessionID}:${detail}`,
    };
}
// parseClaudeHookPayload is the parse/guard entrypoint. It applies the
// session-mismatch guard (payload id vs ctx.harnessSessionID), the
// path-traversal guard (transcript_path under the Claude projects dir), then
// emits canonical Events stamped SourceHook. A dropped payload returns [].
export function parseClaudeHookPayload(raw, ctx) {
    let payload;
    if (typeof raw === "string") {
        try {
            payload = JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    else {
        payload = raw;
    }
    const sessionID = payload.session_id ?? "";
    // Session-mismatch guard: a stray hook from an unrelated session sharing the
    // same settings.json is dropped.
    if (!sessionMatches(ctx.harnessSessionID, sessionID))
        return [];
    // Path-traversal guard: if the payload names a transcript file, it must
    // resolve inside the Claude projects dir for this cwd. A traversal drops the
    // whole payload — a payload lying about its file is not trusted for anything.
    if (payload.transcript_path !== undefined) {
        if (validateTranscriptPath(ctx, payload.transcript_path) === null)
            return [];
    }
    const events = buildEvents(payload, sessionID);
    return events.map((event) => ({ harnessSessionID: sessionID, event }));
}
// buildEvents dispatches on the native hook event name.
function buildEvents(payload, sessionID) {
    switch (payload.hook_event_name) {
        case HookEventSessionStart:
            return [
                marker(EventSessionMeta, RoleSystem, `session-start:${payload.source ?? "startup"}`, sessionID, payload.source ?? "startup"),
            ];
        case HookEventStop:
            return [
                marker(EventTurnBoundary, RoleSystem, "turn-end", sessionID, "stop"),
            ];
        case HookEventSubagentStop:
            return [
                marker(EventTurnBoundary, RoleSystem, "subagent-end", sessionID, "subagent"),
            ];
        case HookEventPostToolUse:
        case HookEventPostTask: {
            const tool = payload.tool_name ?? "";
            const out = [
                marker(EventTurnBoundary, RoleSystem, `post-task:${tool}`, sessionID, `post-task:${tool}`),
            ];
            // A task response carrying message text is emitted as a PROVISIONAL text
            // event tagged SourceHook — no file-identity matching (see hookMerge.ts).
            const text = extractResponseText(payload.tool_response);
            if (text !== "") {
                out.push({
                    role: RoleAssistant,
                    type: EventText,
                    text,
                    source: SourceHook,
                    // No stable file id to reproduce; use a content-derived hook id so the
                    // fallback content hash in eventID() still keeps it provisional.
                    nativeID: undefined,
                });
            }
            return out;
        }
        default:
            return [];
    }
}
// extractResponseText pulls renderable text out of a Task tool_response, which
// may be a plain string or an object with a `content`/`text` field.
function extractResponseText(resp) {
    if (typeof resp === "string")
        return resp;
    if (resp && typeof resp === "object") {
        const o = resp;
        if (typeof o.text === "string")
            return o.text;
        if (typeof o.content === "string")
            return o.content;
        if (Array.isArray(o.content)) {
            let sb = "";
            for (const b of o.content) {
                if (b.type === "text" && typeof b.text === "string")
                    sb += b.text;
            }
            return sb;
        }
    }
    return "";
}
// ClaudeHookProvider is the concrete HookProvider for Claude Code.
export class ClaudeHookProvider {
    ensureConfig(ctx) {
        return specFromProfile(claudeStaticProfile, claudeSettingsPath(ctx));
    }
    parsePayload(raw, ctx) {
        return parseClaudeHookPayload(raw, ctx);
    }
}
//# sourceMappingURL=claude.js.map