// Public barrel for `meta-harness/discovery`.
//
// Re-exports only from src/discovery/** — never from src/internal/**.
//
// Importing "./probes.ts" for its side effect registers the default semver
// probes for every harness, the analogue of Go's package init().
import "./probes.ts"

export {
  type Info,
  type Probe,
  lookup,
  discover,
  registerProbe,
  resetCache,
  defaultProbeTimeoutMs,
} from "./discovery.ts"
export { SemverDashVProbe, semverRe } from "./probes.ts"
export {
  type ModelInfo,
  type DiscoverModelsOptions,
  parseModelPicker,
  knownModels,
  defaultModel,
  isKnownModel,
  discoverModels,
} from "./models.ts"
