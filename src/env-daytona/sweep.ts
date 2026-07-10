// Daytona reaper (design doc Tier-4 requirement): finds and deletes orphaned
// sandboxes by label, so a crashed live-test run doesn't leak billed
// resources. Used both by the live e2e test's afterAll and standalone ops.

import type { Context } from "../async/index.ts"
import { loadDaytonaClass, type DaytonaConfig, type DaytonaSandbox } from "./daytona.ts"

export interface SweepResult {
  swept: string[]
  kept: string[]
  failed: Array<{ id: string; error: string }>
}

/** Lists sandboxes and deletes every one matching ALL of `opts.labels`.
 *
 *  Empty labels throw — an unscoped sweep would delete every sandbox in the
 *  account, which is never the intent (billing-safety backstop). `dryRun`
 *  reports the match set without deleting anything. */
export async function sweep(
  ctx: Context,
  config: DaytonaConfig,
  opts: { labels: Record<string, string>; dryRun?: boolean },
): Promise<SweepResult> {
  if (!opts.labels || Object.keys(opts.labels).length === 0) {
    throw new Error("sweep: empty labels would match every sandbox in the account — refusing")
  }

  const DaytonaClass = await loadDaytonaClass(config)
  const clientConfig: Record<string, unknown> = { apiKey: config.apiKey }
  if (config.apiUrl) clientConfig.apiUrl = config.apiUrl
  if (config.target) clientConfig.target = config.target
  const client = new DaytonaClass(clientConfig)

  const matches: DaytonaSandbox[] = []
  // list() returns an auto-paginating AsyncIterableIterator — draining it via
  // for-await visits every page, so orphans past a page boundary are never
  // silently missed.
  for await (const sandbox of client.list()) {
    if (matchesLabels(sandbox, opts.labels)) matches.push(sandbox)
  }

  const result: SweepResult = { swept: [], kept: [], failed: [] }
  for (const sandbox of matches) {
    const id = sandbox.id ?? sandbox.sandboxId ?? "<unknown>"
    if (opts.dryRun) {
      result.kept.push(id)
      continue
    }
    try {
      await sandbox.delete(60)
      result.swept.push(id)
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

function matchesLabels(sandbox: DaytonaSandbox, want: Record<string, string>): boolean {
  const have = sandbox.labels ?? {}
  return Object.entries(want).every(([k, v]) => have[k] === v)
}
