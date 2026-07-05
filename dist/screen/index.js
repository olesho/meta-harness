// Public barrel for `meta-harness/screen`.
//
// Re-exports only from src/screen/** (never from src/internal/**). The
// implementation lives in ./screen.ts, which is free to depend on the internal
// async toolkit; this barrel exposes only the public surface.
export { Screen, newScreen, } from "./screen.js";
//# sourceMappingURL=index.js.map