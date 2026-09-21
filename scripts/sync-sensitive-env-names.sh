#!/usr/bin/env bash
# sync-sensitive-env-names.sh — freeze the canonical sensitive-env-name contract
# and optionally mirror it into loomcli.
#
# contract/sensitive-env-names.json is the CANONICAL list of environment
# variable names that must never appear inside a sandbox guest, split by role:
#
#   runner_infra          sandbox/runner plumbing (never a provider credential)
#   provider_credentials  backend-CLI credentials; mirrors loomcli's
#                         internal/driver/env.go trustedLocalProviderCredentials
#
# The union, in `runner_infra ++ provider_credentials` order, is exactly
# src/env-daytona/leak-probe.ts's CREDENTIAL_SENSITIVE_ENV_NAMES and exactly the
# name set loomcli's sandboxLeakProbeCommand() emits. Before this contract
# existed those literals were hand-copied in four places and had already drifted
# (CLAUDE_CODE_OAUTH_TOKEN was in env.go and here but missing from loomcli's
# probe, so a leak of it counted as zero).
#
# loomcli vendors this file BYTE-IDENTICALLY at
# internal/driver/testdata/sensitive-env-names.json. Each repo's own offline test
# asserts its in-code literals against its copy; this script freezes the bytes
# and moves them across.
#
# Usage:
#   scripts/sync-sensitive-env-names.sh          regenerate contract/MANIFEST.sha256 in place
#   scripts/sync-sensitive-env-names.sh --check  verify the manifest is current (CI); exit 1 on drift.
#                                                If $LOOMCLI_REPO names a checkout, ALSO byte-compare
#                                                our JSON against its vendored copy.
#   scripts/sync-sensitive-env-names.sh --to DIR regenerate, then mirror the JSON into loomcli repo DIR
#
# NOTE (same limitation as sync-conformance.sh, header lines 60-67): --check
# inside a single repo proves only that THIS repo's manifest is internally
# consistent with its own bytes. Repo-to-repo divergence is caught ONLY by
# running --check with $LOOMCLI_REPO pointing at a checkout, or by re-mirroring
# with --to. CI has no sibling checkout, so that half is a SILENT SKIP there
# (one log line, never a failure) — do not read a green CI run as proof that
# loomcli's vendored copy matches.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contract="$here/contract"
artifact="sensitive-env-names.json"
manifest="$contract/MANIFEST.sha256"

# Where loomcli vendors its copy, relative to that repo's root.
vendored_rel="internal/driver/testdata/$artifact"

sha256() { # file bytes on stdin -> lowercase hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

gen_manifest() { # -> "<hex>  <relpath>" line for the artifact
  printf '%s  %s\n' "$(sha256 < "$contract/$artifact")" "$artifact"
}

mode="gen"; target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode="check" ;;
    --to) shift; target="${1:?--to needs a repo dir}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done

new="$(gen_manifest)"

if [ "$mode" = check ]; then
  if [ ! -f "$manifest" ] || ! diff -q <(printf '%s\n' "$new") "$manifest" >/dev/null; then
    echo "sensitive-env-names DRIFT: contract/MANIFEST.sha256 is stale." >&2
    echo "Run scripts/sync-sensitive-env-names.sh and commit the result." >&2
    exit 1
  fi
  echo "sensitive-env-names manifest OK"

  # Cross-repo half. Absent checkout => silent skip with one explanatory line,
  # so a CI log never reads as though the comparison ran.
  loomcli="${LOOMCLI_REPO:-$HOME/Work/aether/loomcli}"
  if [ -d "$loomcli" ]; then
    if [ ! -f "$loomcli/$vendored_rel" ]; then
      echo "sensitive-env-names DRIFT: $loomcli/$vendored_rel is missing." >&2
      echo "Run scripts/sync-sensitive-env-names.sh --to $loomcli and commit it there." >&2
      exit 1
    fi
    if ! cmp -s "$contract/$artifact" "$loomcli/$vendored_rel"; then
      echo "sensitive-env-names DRIFT: loomcli's vendored copy differs from ours." >&2
      diff -u "$contract/$artifact" "$loomcli/$vendored_rel" >&2 || true
      echo "Run scripts/sync-sensitive-env-names.sh --to $loomcli and commit it there." >&2
      exit 1
    fi
    echo "sensitive-env-names cross-repo OK ($loomcli)"
  else
    echo "sensitive-env-names cross-repo comparison SKIPPED (no checkout at $loomcli; set \$LOOMCLI_REPO to run it)"
  fi
  exit 0
fi

printf '%s\n' "$new" > "$manifest"
echo "wrote $manifest"

if [ -n "$target" ]; then
  mkdir -p "$target/$(dirname "$vendored_rel")"
  cp "$contract/$artifact" "$target/$vendored_rel"
  echo "mirrored $artifact -> $target/$vendored_rel"
fi
