// src/discovery/permission.ts — re-export shim; the parser lives in the chat layer,
// which owns its only consumer. Keeps the one-way discovery → chat edge intact.
export {
  type PermissionRung,
  type PermissionModeSource,
  type PermissionModeReading,
  parsePermissionMode,
  normalizePermissionRung,
} from "../chat/permission.ts";
