// Turn-detection adapter for the OpenCode CLI (github.com/sst/opencode).
//
// v0.1, ahead of corpus recording: no end-of-turn marker, session-id scrape, or
// transcript reader identified yet (the on-disk store is in flux), so it simply
// delegates to the generic adapter. Port of pkg/turns/harness/opencode.
import { GenericAdapter } from "../generic.js";
/** Adapter implements turns.Adapter for the OpenCode CLI. */
export class OpenCodeAdapter extends GenericAdapter {
    name() {
        return "opencode";
    }
}
/** Constructs an OpenCode adapter. */
export function New() {
    return new OpenCodeAdapter();
}
//# sourceMappingURL=opencode.js.map