// The `none` containment (design §3 shipped implementations): identity.
//
// It advertises no boundary — its layer's primitives are all degenerate, so
// compose(inner, none.layer()) is functionally equal to `inner`:
//   - execWrap    → argv/opts unchanged
//   - crossUpload → [] (no crossing; compose uploads straight to the inner path)
//   - crossDownload → []
//   - pathMap     → "" (defer to the inner path — shadow nothing)
//   - teardown    → [] (nothing to tear down)
// This makes `none` the correct baseline for the Tier-2 conformance suite.

import type { Context } from "../async/index.ts"
import type { Containment, ContainmentLayer, ExecOpts, PolicySpec, Workspace } from "./types.ts"

const identityLayer: ContainmentLayer = {
  execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts] {
    return [argv, opts]
  },
  crossUpload(): string[] {
    return []
  },
  crossDownload(): string[] {
    return []
  },
  pathMap(): string {
    return ""
  },
  teardown(): string[] {
    return []
  },
  // No aliasMap: host-URL rewriting defers entirely to the inner workspace.
}

class NoneContainment implements Containment {
  name(): string {
    return "none"
  }

  async preflight(_ctx: Context, _ws: Workspace): Promise<void> {
    // No containment runtime — nothing to check.
  }

  layer(_policy: PolicySpec): ContainmentLayer {
    return identityLayer
  }
}

/** Construct the `none` (identity) containment. */
export function none(): Containment {
  return new NoneContainment()
}
