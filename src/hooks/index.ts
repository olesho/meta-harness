// Public surface of the hooks package: the provider surface types and the
// Claude concrete provider + payload parser.

export {
  specFromProfile,
  type HookContext,
  type HookEntry,
  type HookProvider,
  type HookSpec,
  type StaticHookProfile,
} from "./provider.ts"

export { guardPath, sessionMatches } from "./guard.ts"

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
} from "./claude.ts"
