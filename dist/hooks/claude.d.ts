import { type ParsedEvent } from "../transcript/event.ts";
import { type HookContext, type HookProvider, type HookSpec } from "./provider.ts";
export declare const HookEventStop = "Stop";
export declare const HookEventSessionStart = "SessionStart";
export declare const HookEventSubagentStop = "SubagentStop";
export declare const HookEventPostToolUse = "PostToolUse";
export declare const HookEventPostTask = "PostTask";
export declare const EventTurnBoundary = "turn_boundary";
export declare const claudeHookOwner = "harness/claude";
export interface ClaudeHookPayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    stop_hook_active?: boolean;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
}
export declare function parseClaudeHookPayload(raw: string | ClaudeHookPayload, ctx: HookContext): ParsedEvent[];
export declare class ClaudeHookProvider implements HookProvider {
    ensureConfig(ctx: HookContext): HookSpec;
    parsePayload(raw: string, ctx: HookContext): ParsedEvent[];
}
//# sourceMappingURL=claude.d.ts.map