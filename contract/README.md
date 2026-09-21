# Cross-repo contracts

## `sensitive-env-names.json`

The canonical list of environment variable names that must never appear inside a
sandbox guest, split into two roles:

| Role | Meaning |
| --- | --- |
| `runner_infra` | Sandbox/runner plumbing. Never a provider credential. |
| `provider_credentials` | Backend-CLI credentials. Mirrors loomcli's `internal/driver/env.go` `trustedLocalProviderCredentials` exactly. |

The union, in `runner_infra ++ provider_credentials` order, is exactly
`CREDENTIAL_SENSITIVE_ENV_NAMES` in `src/env-daytona/leak-probe.ts` and exactly the
name set loomcli's `sandboxLeakProbeCommand()` emits.

**meta-harness is canonical.** loomcli vendors this file byte-identically at
`internal/driver/testdata/sensitive-env-names.json`. Nothing reads it at runtime in
either repo — it is a test-only artifact. The in-code literals stay where they are;
the *tests* are what refuse to let them drift.

### Why it exists

The list used to be a hand-copied literal in four places across two repos, and it had
already drifted: `CLAUDE_CODE_OAUTH_TOKEN` was in meta-harness's probe and in loomcli's
`env.go`, but missing from loomcli's own `sandboxLeakProbeCommand()`. A regression that
widened that token into a Daytona sandbox was counted as *zero* leaks and the run
proceeded. See `docs/design/pluggable-environments.md` §6.

### Changing the list

1. Edit `contract/sensitive-env-names.json` here.
2. `scripts/sync-sensitive-env-names.sh --to $LOOMCLI_REPO` — refreezes
   `MANIFEST.sha256` and mirrors the JSON into loomcli.
3. Update the in-code literals in **both** repos until their tests pass:
   - meta-harness: `src/env-daytona/leak-probe.ts`, then `pnpm build` and commit the
     `dist/` diff (`dist/` is tracked here).
   - loomcli: `internal/workflows/builtin/daytona-task-runner.ts` and, for a
     `provider_credentials` change, `internal/driver/env.go`.
4. Land **both** PRs. Landing only one leaves the artifact and a consumer disagreeing.

### Serialization rules

They are part of the contract, because the file is vendored byte-for-byte: 2-space
indent, keys in the order shown, arrays in **declaration order** (not sorted — the
order is the probe's emission order and must stay diffable), LF, trailing newline.
`contract/` is in `.prettierignore` so a formatter run cannot silently reflow it and
break the vendored hash.

### What the gate can and cannot see

`scripts/sync-sensitive-env-names.sh --check` and the vitest suite prove this repo is
self-consistent. Repo-to-repo divergence is caught **only** when `$LOOMCLI_REPO` points
at a checkout, or by re-mirroring with `--to`. CI has no sibling checkout, so that half
is a silent skip there — the same documented limitation as `scripts/sync-conformance.sh`.
Do not read a green CI run as proof that loomcli's vendored copy still matches.
