// Core-owned composition combinator (design §5).
//
// compose(inner, layer) returns a Workspace in which EVERY operation is defined
// in terms of inner-workspace operations, per the §5.1 operation-mapping table.
// Written once so a new containment backend cannot get teardown ordering or
// staging cleanup subtly wrong — pairwise implementation testing collapses into
// "test the combinator + test each layer's primitives".
import { runAll, TeardownError } from "./retention.js";
/** Per-workspace counter so concurrent uploads never collide on a staging path.
 *  Module-scoped and monotonic — Math.random()/Date.now() are unavailable in
 *  this repo's constrained runtime, and a counter is deterministic anyway. */
let stagingSeq = 0;
function basename(p) {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
}
function stagingPath(inner, guest) {
    const n = ++stagingSeq;
    return `${inner.guestPath("tmp")}/env-stage-${n}-${basename(guest)}`;
}
async function execChecked(ctx, inner, argv, what) {
    const r = await inner.exec(ctx, argv);
    if (r.code !== 0) {
        throw new Error(`compose: ${what} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
}
export function compose(inner, layer) {
    return {
        async exec(ctx, argv, opts) {
            // execWrap prefixes the containment's exec command; the whole thing then
            // runs via the INNER exec (the containment runs where inner runs, §5.1).
            const [wrapped, wrappedOpts] = layer.execWrap(argv, opts ?? {});
            return inner.exec(ctx, wrapped, wrappedOpts);
        },
        async upload(ctx, hostPath, guestPath) {
            const stage = stagingPath(inner, guestPath);
            const cross = layer.crossUpload(stage, guestPath);
            if (cross.length === 0) {
                // Identity containment: no policy boundary — upload straight to the
                // final path via the inner workspace.
                await inner.upload(ctx, hostPath, guestPath);
                return;
            }
            // Real boundary: land the file on the inner (staging), then cross it in.
            await inner.upload(ctx, hostPath, stage);
            await execChecked(ctx, inner, cross, "crossUpload");
        },
        async download(ctx, guestPath, hostPath) {
            const stage = stagingPath(inner, guestPath);
            const cross = layer.crossDownload(guestPath, stage);
            if (cross.length === 0) {
                await inner.download(ctx, guestPath, hostPath);
                return;
            }
            // Cross the file out to staging on the inner, then pull staging to host.
            await execChecked(ctx, inner, cross, "crossDownload");
            await inner.download(ctx, stage, hostPath);
        },
        guestPath(kind) {
            // Containment paths SHADOW inner paths; "" defers to the inner path.
            const mapped = layer.pathMap(kind);
            return mapped !== "" ? mapped : inner.guestPath(kind);
        },
        hostAlias(hostUrl) {
            // Fold across BOTH hops: true host → provisioned machine (inner.hostAlias)
            // → contained sandbox (layer.aliasMap, if the layer rewrites URLs).
            const viaInner = inner.hostAlias(hostUrl);
            return layer.aliasMap ? layer.aliasMap(viaInner) : viaInner;
        },
        async destroy(ctx, outcome) {
            // Outer (containment) teardown, THEN inner destroy — per-layer
            // partial-failure aggregated, never short-circuited (§4 / §5.1).
            const errs = await runAll([
                async () => {
                    const t = layer.teardown();
                    if (t.length > 0)
                        await execChecked(ctx, inner, t, "teardown");
                },
                async () => {
                    await inner.destroy(ctx, outcome);
                },
            ]);
            if (errs.length > 0)
                throw new TeardownError(errs, "compose.destroy");
        },
    };
}
//# sourceMappingURL=compose.js.map