import type { Context } from "../async/index.ts";
import { type DaytonaConfig } from "./daytona.ts";
export interface SweepResult {
    swept: string[];
    kept: string[];
    failed: {
        id: string;
        error: string;
    }[];
}
/** Lists sandboxes and deletes every one matching ALL of `opts.labels`.
 *
 *  Empty labels throw — an unscoped sweep would delete every sandbox in the
 *  account, which is never the intent (billing-safety backstop). `dryRun`
 *  reports the match set without deleting anything. */
export declare function sweep(ctx: Context, config: DaytonaConfig, opts: {
    labels: Record<string, string>;
    dryRun?: boolean;
}): Promise<SweepResult>;
//# sourceMappingURL=sweep.d.ts.map