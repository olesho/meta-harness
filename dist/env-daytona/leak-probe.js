// Credential leak detection for sandboxed environments.
//
// The canonical list of sensitive environment variable names that should never
// cross into a sandbox boundary. This list is the source of truth for both the
// in-guest probe (run via exec to count leaks) and host-side redaction logic.
//
// Ported from loomcli daytona-task-runner.ts and env.go to kill the drift
// between codebases: the Go env.go list was manually synced with the TS probe
// and diverged (CLAUDE_CODE_OAUTH_TOKEN is in Go but was missing from TS).
import { shQuote } from "../env/argv.js";
export const CREDENTIAL_SENSITIVE_ENV_NAMES = [
    "DAYTONA_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "CODEX_HOME",
    "LOOM_TASK_RUN_LEASE_TOKEN",
    "LOOM_DRIVER_TASK_RUNNER_CMD_JSON",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CURSOR_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
/**
 * Generate a shell command that probes for credential leaks in the current
 * environment by counting how many of the CREDENTIAL_SENSITIVE_ENV_NAMES are
 * set. The output is a single decimal number.
 *
 * Designed to run inside a sandbox via exec(). If the count is nonzero,
 * a secret reached the sandbox and the run should fail.
 *
 * Uses the same pattern as loomcli's sandboxLeakProbeCommand to ensure
 * consistency across runtimes.
 */
export function credentialLeakProbe() {
    const nameArrays = CREDENTIAL_SENSITIVE_ENV_NAMES.map((name) => `['${name}']`);
    const code = [
        "const names=[",
        ...nameArrays.map((arr) => arr + ","),
        "].map((parts)=>parts.join('_'));",
        "let count=0;",
        "for (const name of names) if (process.env[name]) count++;",
        "console.log(count);",
    ].join("");
    // Shell-quote the entire node -e argument
    return "node -e " + shQuote(code);
}
//# sourceMappingURL=leak-probe.js.map