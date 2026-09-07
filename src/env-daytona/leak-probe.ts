// Credential leak detection for sandboxed environments.
//
// The list of sensitive environment variable names that must never cross into a
// sandbox boundary. Its CANONICAL form lives in `contract/sensitive-env-names.json`,
// which splits it into two roles (`runner_infra`, `provider_credentials`); the array
// below is their concatenation in that exact order, and
// test/env/sensitive_env_contract.test.ts fails if the two ever disagree.
//
// loomcli vendors the same artifact at internal/driver/testdata/sensitive-env-names.json
// and gates its own two literals (sandboxLeakProbeCommand() and env.go's
// trustedLocalProviderCredentials) against it. To CHANGE the list, edit the contract
// file and run scripts/sync-sensitive-env-names.sh --to $LOOMCLI_REPO, then land the PR
// in BOTH repos — see contract/README.md.
//
// The literal is kept here, rather than read from the JSON at runtime, deliberately:
// the probe is a security gate and must not acquire a filesystem dependency.

import { shQuote } from "../env/argv.ts";

export const CREDENTIAL_SENSITIVE_ENV_NAMES = [
  // contract/sensitive-env-names.json -> runner_infra
  "DAYTONA_API_KEY",
  "LOOM_TASK_RUN_LEASE_TOKEN",
  "LOOM_DRIVER_TASK_RUNNER_CMD_JSON",
  // contract/sensitive-env-names.json -> provider_credentials
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CODEX_HOME",
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
 * Each name is emitted SPLIT on "_" — `['DAYTONA','API','KEY']`, rejoined by the
 * guest at runtime — so the probe's own source text carries no literal secret
 * name for a scanner (or a curious guest process listing) to pick up. Same shape
 * as loomcli's sandboxLeakProbeCommand, so the two stay diffable.
 */
export function credentialLeakProbe(): string {
  const nameArrays = CREDENTIAL_SENSITIVE_ENV_NAMES.map(
    (name) => `[${name.split("_").map((part) => `'${part}'`).join(",")}]`,
  );
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
