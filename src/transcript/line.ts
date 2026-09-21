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

  // isApiErrorMessage marks a SYNTHETIC assistant line: Claude Code writes one
  // when an API call failed, with model "<synthetic>" and the rendered error
  // text as its only content block. It is not a reply, and reading it as one is
  // how a failed turn comes back as a success whose "answer" is
  // "API Error: 529 Overloaded".
  isApiErrorMessage?: boolean;

  // error is the harness's OWN machine-readable verdict for that failure:
  // authentication_failed, oauth_org_not_allowed, account_on_hold,
  // verification_required, billing_error, rate_limit, overloaded,
  // invalid_request, model_not_found, server_error, max_output_tokens,
  // cloud_credential_error, unknown. Stable across claude 2.1.181 -> 2.1.278;
  // a value outside it is carried verbatim, never guessed at. Mirrors
  // harness-wrapper's transcript.Line.Error.
  error?: string;
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
