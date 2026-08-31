// Harness environment hygiene.
//
// Port of the Go one-shot's cleanedEnv (cmd/harness-wrapper/run.go): strip
// Claude Code's nesting markers (CLAUDECODE / CLAUDE_CODE_*) from the env handed
// to a harness. When the wrapper — or now the orchestrator, in-process — runs INSIDE a
// Claude Code session, a nested `claude` sees these markers, disables session
// persistence, and never writes the JSONL transcript the reply readers depend
// on. Removing them makes the nested `claude` run as a top-level, persisting
// session.
//
// One CLAUDE_CODE_* key is exempt: CLAUDE_CODE_OAUTH_TOKEN is a credential, not
// a nesting marker. See NESTING_EXEMPT below.
const NESTING_KEY = "CLAUDECODE";
const NESTING_PREFIX = "CLAUDE_CODE_";
/**
 * Keys that match NESTING_PREFIX but are NOT nesting markers, so they must
 * survive the scrub.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is claude's long-lived headless credential
 * (`claude setup-token`) — the equivalent of a ~/.claude login, not a marker a
 * running claude exports. Stripping it makes the spawned harness start
 * unauthenticated in any environment whose only working auth is the token, so
 * it paints the login wall and the turn never completes (PUPPET-309). loomcli
 * makes the same exemption: internal/cli/envfilter/envfilter.go (exact
 * allowlist) and internal/driver/env.go's trustedLocalProviderCredentials.
 *
 * This is a NESTING predicate, not a containment filter: it never governs what
 * crosses into a guest/sandbox (see src/env-daytona/leak-probe.ts, which
 * independently treats this key as sensitive in-guest). Do not reuse it there.
 *
 * Exact match only — CLAUDE_CODE_OAUTH_TOKEN_FILE and friends are still
 * stripped.
 */
const NESTING_EXEMPT = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);
/**
 * True for CLAUDECODE and any CLAUDE_CODE_* variable (the nesting markers),
 * except the credential keys in {@link NESTING_EXEMPT}.
 */
export function isClaudeNestingEnvKey(key) {
    if (NESTING_EXEMPT.has(key))
        return false;
    return key === NESTING_KEY || key.startsWith(NESTING_PREFIX);
}
/**
 * Return env (as "KEY=VALUE" entries) with Claude Code's nesting markers
 * removed. When `env` is undefined/null the current process environment is
 * materialized and cleaned — mirroring the Go cleanedEnv(), which reads
 * os.Environ(). Materializing is load-bearing: a PTY child inherits the parent
 * environment when no explicit env is passed, so the only way to strip an
 * inherited marker is to hand the child an explicit, cleaned env.
 */
export function cleanHarnessEnv(env) {
    const src = env ?? processEnvEntries();
    const out = [];
    for (const entry of src) {
        const eq = entry.indexOf("=");
        const key = eq >= 0 ? entry.slice(0, eq) : entry;
        if (isClaudeNestingEnvKey(key))
            continue;
        out.push(entry);
    }
    return out;
}
function processEnvEntries() {
    const out = [];
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined)
            continue;
        out.push(`${k}=${v}`);
    }
    return out;
}
//# sourceMappingURL=env.js.map