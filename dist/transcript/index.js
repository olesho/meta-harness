// Public barrel for `meta-harness/transcript`.
//
// Exports only intended public symbols. Nothing from src/internal/** is
// re-exported here (the error sentinels are constructed via the internal
// toolkit but are themselves a public part of this package's surface).
// Core event model.
export { SchemaVersion, RoleUser, RoleAssistant, RoleTool, RoleSystem, EventText, EventToolUse, EventToolResult, EventSessionMeta, SourceLive, SourceFile, eventID, turnsFromEvents, envelope, toPublicJSON, } from "./event.js";
// Durable wire codec.
export { marshalParsedEvents, unmarshalParsedEvents } from "./eventWire.js";
// Error sentinels.
export { ErrEmptySessionID, ErrEmptyWorkingDir, ErrSessionNotFound } from "./errors.js";
// Per-harness readers.
export { PiReader, slugForCwd } from "./pi/pi.js";
export { CodexReader } from "./codex/codex.js";
export { events as codexEvents, parseRollout } from "./codex/parseCodex.js";
export { locateLatestSession, readSessionMeta } from "./codex/locate.js";
export { ClaudeCodeReader, encodedCWD } from "./claudecode/claudecode.js";
export { events as claudecodeEvents } from "./claudecode/parseClaude.js";
//# sourceMappingURL=index.js.map