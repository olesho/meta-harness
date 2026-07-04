// Public barrel for `meta-harness/transcript`.
//
// Exports only intended public symbols. Nothing from src/internal/** is
// re-exported here (the error sentinels are constructed via the internal
// toolkit but are themselves a public part of this package's surface).

// Core event model.
export {
  SchemaVersion,
  RoleUser,
  RoleAssistant,
  RoleTool,
  RoleSystem,
  EventText,
  EventToolUse,
  EventToolResult,
  EventSessionMeta,
  SourceLive,
  SourceFile,
  eventID,
  turnsFromEvents,
  envelope,
  toPublicJSON,
  type Event,
  type Turn,
  type ParsedEvent,
  type EventEnvelope,
} from "./event.ts"

// Durable wire codec.
export { marshalParsedEvents, unmarshalParsedEvents } from "./eventWire.ts"

// Reader interface.
export type { Reader } from "./reader.ts"

// Error sentinels.
export { ErrEmptySessionID, ErrEmptyWorkingDir, ErrSessionNotFound } from "./errors.ts"

// Per-harness readers.
export { PiReader, slugForCwd } from "./pi/pi.ts"
export { CodexReader } from "./codex/codex.ts"
export { events as codexEvents, parseRollout } from "./codex/parseCodex.ts"
export { locateLatestSession, readSessionMeta } from "./codex/locate.ts"
export { ClaudeCodeReader, encodedCWD } from "./claudecode/claudecode.ts"
export { events as claudecodeEvents } from "./claudecode/parseClaude.ts"
