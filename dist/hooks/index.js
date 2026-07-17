// Public barrel for the config-install leaf utilities of the hook subsystem.
// Pure filesystem helpers — no runtime/chat dependency.
export { withLockedFile, atomicWriteFileSync, lockStaleTTLMs, } from "./lock.js";
export { hookMarkerPrefix, renderHookCommand, isManagedHookCommand, } from "./command.js";
export { ensureSettingsJSONHooks, removeManagedHooks, } from "./settingsjson.js";
export { resolveWithinBase, isWithinBase, PathEscapeError, } from "./pathguard.js";
//# sourceMappingURL=index.js.map