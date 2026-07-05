export declare const TypeUser = "user";
export declare const TypeAssistant = "assistant";
export declare const ContentTypeText = "text";
export declare const ContentTypeToolUse = "tool_use";
export interface Line {
    type: string;
    role?: string;
    uuid: string;
    message: unknown;
    timestamp?: string;
}
export interface AssistantMessage {
    content: ContentBlock[];
}
export interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
}
//# sourceMappingURL=line.d.ts.map