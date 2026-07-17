export { withLockedFile, atomicWriteFileSync, lockStaleTTLMs, type LockOptions, } from "./lock.ts";
export { hookMarkerPrefix, renderHookCommand, isManagedHookCommand, type RenderHookCommandOptions, } from "./command.ts";
export { ensureSettingsJSONHooks, removeManagedHooks, type SettingsHookCmd, type SettingsHookMatcher, type ManagedHooks, } from "./settingsjson.ts";
export { resolveWithinBase, isWithinBase, PathEscapeError, } from "./pathguard.ts";
export { specFromProfile, type HookContext, type HookEntry, type HookProvider, type HookSpec, type StaticHookProfile, } from "./provider.ts";
export { guardPath, sessionMatches } from "./guard.ts";
export { ClaudeHookProvider, EventTurnBoundary, HookEventPostTask, HookEventPostToolUse, HookEventSessionStart, HookEventStop, HookEventSubagentStop, claudeHookOwner, parseClaudeHookPayload, type ClaudeHookPayload, } from "./claude.ts";
//# sourceMappingURL=index.d.ts.map