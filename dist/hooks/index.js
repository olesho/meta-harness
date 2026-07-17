// Public surface of the hooks package.
//
// Config-install leaf utilities (pure filesystem helpers — no runtime/chat
// dependency) plus the provider surface types and the Claude concrete provider
// + payload parser.
export { withLockedFile, atomicWriteFileSync, lockStaleTTLMs, } from "./lock.js";
export { hookMarkerPrefix, renderHookCommand, isManagedHookCommand, } from "./command.js";
export { ensureSettingsJSONHooks, removeManagedHooks, } from "./settingsjson.js";
export { resolveWithinBase, isWithinBase, PathEscapeError, } from "./pathguard.js";
export { specFromProfile, } from "./provider.js";
export { guardPath, sessionMatches } from "./guard.js";
export { ClaudeHookProvider, EventTurnBoundary, HookEventPostTask, HookEventPostToolUse, HookEventSessionStart, HookEventStop, HookEventSubagentStop, claudeHookOwner, parseClaudeHookPayload, } from "./claude.js";
//# sourceMappingURL=index.js.map