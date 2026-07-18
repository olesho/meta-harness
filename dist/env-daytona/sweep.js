// Daytona reaper (design doc Tier-4 requirement): finds and deletes orphaned
// sandboxes by label, so a crashed live-test run doesn't leak billed
// resources. Used both by the live e2e test's afterAll and standalone ops.
import { loadDaytonaClass, } from "./daytona.js";
/** Lists sandboxes and deletes every one matching ALL of `opts.labels`.
 *
 *  Empty labels throw — an unscoped sweep would delete every sandbox in the
 *  account, which is never the intent (billing-safety backstop). `dryRun`
 *  reports the match set without deleting anything. */
export async function sweep(ctx, config, opts) {
    if (!opts.labels || Object.keys(opts.labels).length === 0) {
        throw new Error("sweep: empty labels would match every sandbox in the account — refusing");
    }
    const DaytonaClass = await loadDaytonaClass(config);
    const clientConfig = { apiKey: config.apiKey };
    if (config.apiUrl)
        clientConfig.apiUrl = config.apiUrl;
    if (config.target)
        clientConfig.target = config.target;
    const client = new DaytonaClass(clientConfig);
    const matches = [];
    // list() returns an auto-paginating AsyncIterableIterator — draining it via
    // for-await visits every page, so orphans past a page boundary are never
    // silently missed.
    for await (const sandbox of client.list()) {
        if (matchesLabels(sandbox, opts.labels))
            matches.push(sandbox);
    }
    const result = { swept: [], kept: [], failed: [] };
    for (const sandbox of matches) {
        const id = sandbox.id ?? sandbox.sandboxId ?? "<unknown>";
        if (opts.dryRun) {
            result.kept.push(id);
            continue;
        }
        try {
            await sandbox.delete(60);
            result.swept.push(id);
        }
        catch (error) {
            result.failed.push({
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}
function matchesLabels(sandbox, want) {
    const have = sandbox.labels ?? {};
    return Object.entries(want).every(([k, v]) => have[k] === v);
}
//# sourceMappingURL=sweep.js.map