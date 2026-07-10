// Core lifecycle engine (design §4).
//
// env() owns the canonical acquisition order and the reverse-order failure
// unwind. Implementations (provisioners, containments, injectors) never sequence
// this themselves — that is what makes the ordering a contract rather than an
// implementation accident.
//
//   1. provisioner.preflight            host-side, zero resources
//   2. provisioner.create      → inner Workspace          ── resources exist here
//   3. containment.preflight(inner)     runtime capability checks, via inner exec
//   4. compose(inner, layer)   → composed Workspace
//   5. redactions() registered, THEN injector.apply(composedWs)
//   6. (turns run — out of this module's scope)
//   7. destroy: injector.cleanup → containment teardown → inner destroy
import { compose } from "./compose.js";
import { runAll, TeardownError } from "./retention.js";
/** A Redactor that drops every secret — the default when a caller wires no log
 *  sink. Redaction is still SEQUENCED correctly (before apply); it just goes
 *  nowhere. */
const noopRedactor = { register() { } };
export async function env(ctx, cfg) {
    const { provision, contain, spec } = cfg;
    const injectors = cfg.injectors ?? [];
    const redactor = cfg.redactor ?? noopRedactor;
    const policy = cfg.policy ?? {};
    // Cleanup thunks pushed in ACQUISITION order; unwound in reverse. Each injector
    // cleanup is pushed BEFORE its apply(), so a half-failed apply still cleans up
    // (design §4 step 5). Setup-failure unwind ALWAYS destroys (retention ignored).
    const unwind = [];
    // `teardownWs` starts as the inner workspace and is upgraded to the composed
    // workspace once compose() runs, so the single workspace-destroy thunk always
    // tears down the deepest layer acquired.
    let teardownWs;
    try {
        // 1. host-side preflight — zero resources.
        await provision.preflight(ctx);
        // 2. create — resources exist from here; register its teardown immediately.
        const inner = await provision.create(ctx, spec);
        teardownWs = inner;
        unwind.push(() => teardownWs.destroy(ctx, "setup-failure"));
        // 3. containment runtime capability checks, via inner exec.
        await contain.preflight(ctx, inner);
        // 4. compose — the workspace-destroy thunk now tears down containment + inner.
        //    A containment with an acquire hook creates its resources HERE (never in
        //    preflight — capability checks only) and hands back a layer closed over
        //    them; acquire failure unwinds the inner via the thunk pushed above.
        const layer = contain.acquire
            ? await contain.acquire(ctx, inner, policy)
            : contain.layer(policy);
        const composed = compose(inner, layer);
        teardownWs = composed;
        // 5. redactions registered BEFORE any apply (§4): a half-completed apply()
        //    can never emit an unredacted secret. Apply against the COMPOSED
        //    workspace so a file-injected token lands INSIDE the containment boundary.
        for (const inj of injectors) {
            for (const secret of inj.redactions())
                redactor.register(secret);
            // Push cleanup before apply — it must run even if this apply half-fails.
            unwind.push(() => inj.cleanup(ctx, composed));
            await inj.apply(ctx, composed);
        }
        // 6/7. Hand back the composed workspace + a retention-honoring destroy that
        //      unwinds in reverse (injector cleanup → containment teardown → inner).
        return {
            workspace: composed,
            async destroy(dctx, outcome = "success") {
                const errs = await runAll([
                    // Reverse acquisition: last-applied injector cleans up first.
                    ...[...injectors].reverse().map((inj) => () => inj.cleanup(dctx, composed)),
                    () => composed.destroy(dctx, outcome),
                ]);
                if (errs.length > 0)
                    throw new TeardownError(errs, "env.destroy");
            },
        };
    }
    catch (setupErr) {
        // Any failure in steps 1–5 unwinds all acquired layers in reverse order,
        // best-effort, errors aggregated, never short-circuited (§4).
        const teardownErrs = await runAll([...unwind].reverse());
        if (teardownErrs.length > 0) {
            // Surface the ORIGINAL cause first, with teardown failures attached — the
            // setup error is why we are unwinding at all.
            throw new TeardownError([setupErr, ...teardownErrs], "env: setup failed and unwind hit errors");
        }
        throw setupErr;
    }
}
//# sourceMappingURL=env.js.map