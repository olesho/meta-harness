// Transcript line types for parsing JSONL transcripts written by AI coding
// agents (Claude Code, Cursor). Ported from harness-wrapper's line.go
// (originally entireio/cli) via loomcli's internal/sessions/transcript.
// Message type constants for transcript lines.
export const TypeUser = "user";
export const TypeAssistant = "assistant";
// Content type constants for content blocks within messages.
export const ContentTypeText = "text";
export const ContentTypeToolUse = "tool_use";
//# sourceMappingURL=line.js.map