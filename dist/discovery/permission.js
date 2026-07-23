// src/discovery/permission.ts — re-export shim; the parser lives in the chat layer,
// which owns its only consumer. Keeps the one-way discovery → chat edge intact.
export { parsePermissionMode, normalizePermissionRung, } from "../chat/permission.js";
//# sourceMappingURL=permission.js.map