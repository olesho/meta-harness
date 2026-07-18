// Transcript line types for parsing JSONL transcripts written by AI coding
// agents (Claude Code, Cursor). Ported from harness-wrapper's line.go
// (originally entireio/cli) via loomcli's internal/sessions/transcript.

// Message type constants for transcript lines.
export const TypeUser = "user";
export const TypeAssistant = "assistant";

// Content type constants for content blocks within messages.
export const ContentTypeText = "text";
export const ContentTypeToolUse = "tool_use";

// Line represents a single line in a Claude Code or Cursor JSONL transcript.
// Claude Code uses "type"; Cursor uses "role" (see normalizeLineType).
export interface Line {
  type: string;
  role?: string;
  uuid: string;
  message: unknown; // raw parsed JSON of the "message" field
  timestamp?: string;
}

// AssistantMessage represents an assistant message in the transcript.
export interface AssistantMessage {
  content: ContentBlock[];
}

// ContentBlock represents a block within an assistant message.
export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
