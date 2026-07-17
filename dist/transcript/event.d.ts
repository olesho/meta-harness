export declare const SchemaVersion = 1;
export declare const RoleUser = "user";
export declare const RoleAssistant = "assistant";
export declare const RoleTool = "tool";
export declare const RoleSystem = "system";
export declare const EventText = "text";
export declare const EventToolUse = "tool_use";
export declare const EventToolResult = "tool_result";
export declare const EventSessionMeta = "session_meta";
export declare const SourceLive = "live";
export declare const SourceFile = "file";
export declare const SourceHook = "hook";
export interface Event {
    seq?: number;
    timestamp?: Date;
    role?: string;
    type?: string;
    text?: string;
    toolName?: string;
    toolUseID?: string;
    toolInput?: string;
    output?: string;
    uuid?: string;
    schemaVersion?: number;
    source?: string;
    nativeID?: string;
}
export declare function eventID(e: Event): string;
export interface Turn {
    role: string;
    text: string;
    timestamp?: Date;
}
export declare function turnsFromEvents(events: Event[]): Turn[];
export interface ParsedEvent {
    harnessSessionID: string;
    parentSessionID?: string;
    event: Event;
}
export interface EventEnvelope {
    runID: string;
    harness: string;
    harnessSessionID: string;
    parentSessionID?: string;
    event: Event;
}
export declare function envelope(pe: ParsedEvent, runID: string, harness: string): EventEnvelope;
export declare function toPublicJSON(e: Event): Record<string, unknown>;
//# sourceMappingURL=event.d.ts.map