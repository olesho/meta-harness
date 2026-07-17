// Public barrel for the config-install leaf utilities of the hook subsystem.
// Pure filesystem helpers — no runtime/chat dependency.

export {
  withLockedFile,
  atomicWriteFileSync,
  lockStaleTTLMs,
  type LockOptions,
} from "./lock.ts"

export {
  hookMarkerPrefix,
  renderHookCommand,
  isManagedHookCommand,
  type RenderHookCommandOptions,
} from "./command.ts"

export {
  ensureSettingsJSONHooks,
  removeManagedHooks,
  type SettingsHookCmd,
  type SettingsHookMatcher,
  type ManagedHooks,
} from "./settingsjson.ts"

export {
  resolveWithinBase,
  isWithinBase,
  PathEscapeError,
} from "./pathguard.ts"
