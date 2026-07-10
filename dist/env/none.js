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
const identityLayer = {
    execWrap(argv, opts) {
        return [argv, opts];
    },
    crossUpload() {
        return [];
    },
    crossDownload() {
        return [];
    },
    pathMap() {
        return "";
    },
    teardown() {
        return [];
    },
    // No aliasMap: host-URL rewriting defers entirely to the inner workspace.
};
class NoneContainment {
    name() {
        return "none";
    }
    async preflight(_ctx, _ws) {
        // No containment runtime — nothing to check.
    }
    layer(_policy) {
        return identityLayer;
    }
}
/** Construct the `none` (identity) containment. */
export function none() {
    return new NoneContainment();
}
//# sourceMappingURL=none.js.map