import type { Context } from "../async/index.ts";
import type { Containment, ContainmentLayer, PolicySpec, Workspace } from "../env/types.ts";
/** CLI runner result shape. */
export interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** Injectable host runner for `openshell …` invocations. Tests script the daemon
 *  without a live gateway; default spawns via node:child_process. */
export type CliRunner = (argv: string[]) => CliResult;
/** Normalize an agentId into an OpenShell sandbox name: `openshell-` + lowercased,
 *  charset-bounded (`[a-z0-9-]`), length-bounded slug with hash suffix on
 *  truncation. Collision-resistant and deterministic for crash recovery. */
export declare function sandboxName(agentId: string): string;
/** Rewrite a loopback URL to a guest-reachable address for the driver.
 *  Throws when loopback can't be routed and no override is configured. */
export declare function resolveGuestUrl(hostUrl: string, driver: string, guestOverride?: string): string;
/** Policy generation: per-tier filesystem sets, landlock, per-binary egress.
 *  Pure function, no I/O. */
export interface PolicyScopes {
    tier: string;
    modelHost: string;
    modelPort?: number;
    fleetHost: string;
    fleetPort: number;
    harnessPath: string;
}
export declare function generatePolicy(scopes: PolicyScopes): string;
/** OpenShell containment implementation. */
export declare class OpenShellContainment implements Containment {
    private opts;
    private cli;
    private driver;
    private provider;
    private guestPath;
    constructor(opts: {
        driver?: string;
        provider?: string;
        guestPath?: string;
        /** Default agentId for sandbox naming when policy.agentId is absent. */
        agentId?: string;
        /** Image/Dockerfile ref for `sandbox create --from` (e.g. a node-bearing
         *  image when the gateway's default image lacks node). */
        from?: string;
    }, cli?: CliRunner);
    name(): string;
    preflight(_ctx: Context, _ws: Workspace): Promise<void>;
    layer(policy: PolicySpec): ContainmentLayer;
    /** Create the sandbox (lifecycle step 4 — containment resources exist from
     *  here) and return a layer closed over its name. All commands run via the
     *  INNER workspace's exec (containment runs where inner runs, §5.1). */
    acquire(ctx: Context, ws: Workspace, policy: PolicySpec): Promise<ContainmentLayer>;
}
export declare function openshell(opts?: {
    driver?: string;
    provider?: string;
    guestPath?: string;
    agentId?: string;
    from?: string;
    cli?: CliRunner;
}): Containment;
//# sourceMappingURL=index.d.ts.map