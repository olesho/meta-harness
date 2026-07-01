// Harness environment hygiene.
//
// Port of the Go one-shot's cleanedEnv (cmd/harness-wrapper/run.go): strip
// Claude Code's nesting markers (CLAUDECODE / CLAUDE_CODE_*) from the env handed
// to a harness. When the wrapper — or now orche, in-process — runs INSIDE a
// Claude Code session, a nested `claude` sees these markers, disables session
// persistence, and never writes the JSONL transcript the reply readers depend
// on. Removing them makes the nested `claude` run as a top-level, persisting
// session.

const NESTING_KEY = "CLAUDECODE"
const NESTING_PREFIX = "CLAUDE_CODE_"

/** True for CLAUDECODE and any CLAUDE_CODE_* variable (the nesting markers). */
export function isClaudeNestingEnvKey(key: string): boolean {
  return key === NESTING_KEY || key.startsWith(NESTING_PREFIX)
}

/**
 * Return env (as "KEY=VALUE" entries) with Claude Code's nesting markers
 * removed. When `env` is undefined/null the current process environment is
 * materialized and cleaned — mirroring the Go cleanedEnv(), which reads
 * os.Environ(). Materializing is load-bearing: a PTY child inherits the parent
 * environment when no explicit env is passed, so the only way to strip an
 * inherited marker is to hand the child an explicit, cleaned env.
 */
export function cleanHarnessEnv(env?: string[] | null): string[] {
  const src = env ?? processEnvEntries()
  const out: string[] = []
  for (const entry of src) {
    const eq = entry.indexOf("=")
    const key = eq >= 0 ? entry.slice(0, eq) : entry
    if (isClaudeNestingEnvKey(key)) continue
    out.push(entry)
  }
  return out
}

function processEnvEntries(): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    out.push(`${k}=${v}`)
  }
  return out
}
