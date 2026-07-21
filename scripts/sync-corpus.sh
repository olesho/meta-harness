#!/usr/bin/env bash
# sync-corpus.sh — parameterized vendoring for the shared cross-language corpora.
#
# Generalizes the former auth-specific sync into ONE script covering every
# corpus (`auth`, `wire`, ...). The canonical side lives in harness-wrapper; this
# repo vendors byte-identical copies under test/corpus/<name>/ and freezes them
# with a MANIFEST.sha256 (hash of every fixture file, excluding the manifest and
# README.md).
#
# Usage:
#   sync-corpus.sh <name>            Vendor test/corpus/<name> from the canonical
#                                    repo ($HARNESS_WRAPPER_REPO), then rebuild
#                                    this repo's MANIFEST.sha256.
#   sync-corpus.sh <name> --check    Verify test/corpus/<name>/MANIFEST.sha256 is
#                                    current for the vendored bytes (drift guard);
#                                    if $HARNESS_WRAPPER_REPO is set, also verify
#                                    OUR bytes equal the canonical repo's.
#   sync-corpus.sh <name> --to DIR   Copy this repo's vendored corpus into DIR
#                                    (so the other repo can --check against it).
#
# NOTE: --check inside a single repo proves only that THIS repo's manifest is
# internally consistent. Repo-to-repo divergence (two internally consistent but
# unequal manifests) is caught only by running --check with $HARNESS_WRAPPER_REPO
# set, or by re-mirroring via --to. This mirrors the auth corpus's limitation.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

name="${1:-}"
if [ -z "$name" ]; then
  echo "usage: sync-corpus.sh <name> [--check | --to DIR]" >&2
  exit 2
fi
shift

corpus="$here/test/corpus/$name"

# Recompute the canonical MANIFEST.sha256 body for a corpus dir: one
# "<sha256>  <posix-relpath>" line per file, excluding MANIFEST.sha256 and
# README.md, sorted by line. Must match test/helpers/corpus.ts::computeManifest.
compute_manifest() {
  local root="$1"
  ( cd "$root" && \
    find . -type f \
      ! -name MANIFEST.sha256 ! -name README.md \
      | sed 's#^\./##' \
      | LC_ALL=C sort \
      | while IFS= read -r rel; do
          hash="$(shasum -a 256 "$rel" | awk '{print $1}')"
          printf '%s  %s\n' "$hash" "$rel"
        done )
}

mode="${1:-sync}"
case "$mode" in
  --check)
    [ -d "$corpus" ] || { echo "corpus not found: $corpus" >&2; exit 1; }
    got="$(compute_manifest "$corpus")"
    if ! diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >/dev/null; then
      echo "FAIL: test/corpus/$name/MANIFEST.sha256 is stale — re-run sync-corpus.sh $name" >&2
      diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >&2 || true
      exit 1
    fi
    echo "ok: test/corpus/$name manifest is current"
    if [ -n "${HARNESS_WRAPPER_REPO:-}" ]; then
      src="$HARNESS_WRAPPER_REPO/test/corpus/$name"
      [ -d "$src" ] || { echo "canonical corpus not found: $src" >&2; exit 1; }
      if ! diff -u <(compute_manifest "$src") <(printf '%s\n' "$got") >/dev/null; then
        echo "FAIL: test/corpus/$name has DIVERGED from canonical ($src)" >&2
        exit 1
      fi
      echo "ok: test/corpus/$name matches canonical $src"
    fi
    ;;

  --to)
    dest="${2:-}"
    [ -n "$dest" ] || { echo "usage: sync-corpus.sh $name --to DIR" >&2; exit 2; }
    [ -d "$corpus" ] || { echo "corpus not found: $corpus" >&2; exit 1; }
    mkdir -p "$dest"
    # Mirror bytes exactly (including MANIFEST.sha256) so the other side can --check.
    ( cd "$corpus" && find . -type f | sed 's#^\./##' | while IFS= read -r rel; do
        mkdir -p "$dest/$(dirname "$rel")"
        cp "$rel" "$dest/$rel"
      done )
    echo "ok: mirrored test/corpus/$name -> $dest"
    ;;

  sync)
    repo="${HARNESS_WRAPPER_REPO:-}"
    [ -n "$repo" ] || { echo "set HARNESS_WRAPPER_REPO to the canonical harness-wrapper checkout" >&2; exit 2; }
    src="$repo/test/corpus/$name"
    [ -d "$src" ] || { echo "canonical corpus not found: $src" >&2; exit 1; }
    rm -rf "$corpus"
    mkdir -p "$corpus"
    ( cd "$src" && find . -type f | sed 's#^\./##' | while IFS= read -r rel; do
        mkdir -p "$corpus/$(dirname "$rel")"
        cp "$rel" "$corpus/$rel"
      done )
    compute_manifest "$corpus" > "$corpus/MANIFEST.sha256"
    echo "ok: vendored test/corpus/$name from $src"
    ;;

  *)
    echo "unknown mode: $mode (expected --check or --to)" >&2
    exit 2
    ;;
esac
