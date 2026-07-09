// Public barrel for `meta-harness/discovery`.
//
// Re-exports only from src/discovery/** — never from src/internal/**.
//
// Importing "./probes.ts" for its side effect registers the default semver
// probes for every harness, the analogue of Go's package init().
import "./probes.js";
export { lookup, discover, registerProbe, resetCache, defaultProbeTimeoutMs, } from "./discovery.js";
export { SemverDashVProbe, semverRe } from "./probes.js";
export { parseModelPicker, knownModels, defaultModel, isKnownModel, discoverModels, } from "./models.js";
//# sourceMappingURL=index.js.map