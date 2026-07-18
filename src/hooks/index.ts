// Public surface of the hooks package.
//
// Config-install leaf utilities (pure filesystem helpers — no runtime/chat
// dependency) plus the provider surface types and the Claude concrete provider
// + payload parser.

export {
  withLockedFile,
  atomicWriteFileSync,
  lockStaleTTLMs,
  type LockOptions,
} from "./lock.ts";

export {
  hookMarkerPrefix,
  renderHookCommand,
  isManagedHookCommand,
  type RenderHookCommandOptions,
} from "./command.ts";

export {
  ensureSettingsJSONHooks,
  removeManagedHooks,
  type SettingsHookCmd,
  type SettingsHookMatcher,
  type ManagedHooks,
} from "./settingsjson.ts";

export {
  resolveWithinBase,
  isWithinBase,
  PathEscapeError,
} from "./pathguard.ts";

export {
  specFromProfile,
  type HookContext,
  type HookEntry,
  type HookProvider,
  type HookSpec,
  type StaticHookProfile,
} from "./provider.ts";

export { guardPath, sessionMatches } from "./guard.ts";

export {
  appendSpool,
  drainSpool,
  spoolFileName,
  spoolFilePath,
} from "./spool.ts";

export {
  ClaudeHookProvider,
  EventTurnBoundary,
  HookEventPostTask,
  HookEventPostToolUse,
  HookEventSessionStart,
  HookEventStop,
  HookEventSubagentStop,
  claudeHookOwner,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
} from "./claude.ts";
