#!/usr/bin/env bash
# sync-conformance.sh — vendor the cross-language CONFORMANCE corpus.
#
# The canonical side is harness-wrapper's test/conformance/ (regenerated there by
# `make regen-conformance`; only that repo regenerates, this repo only consumes).
# We vendor a byte-identical copy into test/conformance/ — the default path
# harness-wrapper's scripts/check-conformance-corpus.sh expects (it overrides via
# $META_HARNESS_CORPUS_SUBDIR). That check compares ONLY the two MANIFEST.sha256
# files, so our manifest must recompute to the canonical bytes exactly.
#
# ── What we copy: *.json + README.md, nothing else ───────────────────────────
#
# Go's computeManifest (harness-wrapper/test/conformance/conformance_test.go)
# walks the corpus and hashes EVERY `*.json` and nothing else. The canonical tree
# also holds Go sources (`conformance_test.go`, `neutral/neutral.go`) that are the
# GENERATOR, not the corpus; copying them here would drop Go source into our tree
# and — for any future manifest convention that is not `*.json`-only — break
# parity by construction. So the vendoring filter is `*.json` plus `README.md`
# (docs, deliberately unhashed on both sides).
#
# ── Why this does NOT follow sync-permission-mode-corpus.sh ──────────────────
#
# There are THREE manifest conventions live in the family; do not harmonise them
# without re-deriving this script's parity argument first:
#
#   1. Go conformance `computeManifest` — hashes `*.json` ONLY.  ← what we mirror
#   2. scripts/sync-corpus.sh `compute_manifest` and
#      test/helpers/corpus.ts `computeManifest` — hash every file EXCEPT
#      MANIFEST.sha256 and README.md.
#   3. harness-wrapper/scripts/sync-permission-mode-corpus.sh `gen_manifest` —
#      hashes every file except MANIFEST.sha256, i.e. keeps README.md IN.
#
# This script must implement (1), because the file it has to reproduce byte-for-
# byte is the one Go writes. Under the `*.json` + README.md copy filter the two
# file SETS coincide with (2)'s as well, and the line format is shared
# ("<sha256>  <posix-relpath>", sorted by relpath in byte order, "%s  %s\n",
# trailing newline) — which is exactly what lets the vendored MANIFEST.sha256
# recompute locally to the same bytes. Adopting (3) would put README.md into our
# manifest and ONLY ours, and check-conformance-corpus.sh would fail forever.
#
# We therefore copy the canonical MANIFEST.sha256 VERBATIM *and* recompute it
# locally, and fail loudly if the two ever disagree.
#
# Usage:
#   sync-conformance.sh              Vendor test/conformance/ from the canonical
#                                    repo ($HARNESS_WRAPPER_REPO, default
#                                    ~/Work/aether/harness-wrapper), then assert
#                                    the copied and recomputed manifests match.
#   sync-conformance.sh --check      Verify test/conformance/MANIFEST.sha256 is
#                                    current for the vendored bytes (drift guard,
#                                    usable in CI here); if $HARNESS_WRAPPER_REPO
#                                    points at a checkout, also verify OUR bytes
#                                    equal the canonical repo's.
#   sync-conformance.sh --to DIR     Copy our vendored corpus into DIR.
#
# NOTE (same limitation as sync-corpus.sh): --check inside a single repo proves
# only that THIS repo's manifest is internally consistent with its own bytes.
# Repo-to-repo divergence (two internally consistent but unequal manifests) is
# caught only by running --check with $HARNESS_WRAPPER_REPO set, by --to
# re-mirroring, or by harness-wrapper's scripts/check-conformance-corpus.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
corpus="$here/test/conformance"

# Recompute the canonical MANIFEST.sha256 body for a corpus dir: one
# "<sha256>  <posix-relpath>" line per *.json file, sorted by relative path in
# byte order. Must match Go's computeManifest (conformance_test.go) — see header.
compute_manifest() {
  local root="$1"
  (
    cd "$root" &&
      find . -type f -name '*.json' |
      sed 's#^\./##' |
      LC_ALL=C sort |
      while IFS= read -r rel; do
        hash="$(shasum -a 256 "$rel" | awk '{print $1}')"
        printf '%s  %s\n' "$hash" "$rel"
      done
  )
}

# Prepend the local vendoring banner to the copied README.md ($1 = corpus dir).
# README.md is hashed by NEITHER manifest convention (see header), so extending
# it cannot affect parity — and doing it here, rather than by hand, means the
# note survives the next `rm -rf` + re-copy instead of being silently dropped.
prepend_readme_banner() {
  local dir="$1" canonical
  canonical="$(cat "$dir/README.md")"
  cat > "$dir/README.md" <<'BANNER'
<!-- VENDORED COPY — do not hand-edit. Re-run scripts/sync-conformance.sh. -->

# Vendored here — read this first

This directory is a **vendored, consume-only** copy of harness-wrapper's
`test/conformance/`, pulled by `scripts/sync-conformance.sh`. Only `*.json` and
this README are copied: the canonical tree also holds the Go *generators*
(`conformance_test.go`, `neutral/neutral.go`), which are not corpus data and are
deliberately left behind. `MANIFEST.sha256` is copied verbatim **and** recomputed
locally; the sync fails if the two disagree. `README.md` is hashed by neither
side's manifest, which is why this banner is free to exist.

Regenerating the corpus is harness-wrapper's job (`make regen-conformance`).
Never hand-edit a fixture here — change the Go types, regenerate there, re-sync.

## Which artifact is this? Three, not two

| Artifact | Path | Kind | Consumer |
| --- | --- | --- | --- |
| **Conformance corpus** (this) | `test/conformance/` | OFFLINE vendored goldens | `test/conformance_corpus.test.ts` |
| **Wire corpus** | `test/corpus/wire/` | OFFLINE vendored goldens | `test/wire_corpus.test.ts` |
| **Live conformance suite** | `test/conformance.test.ts` | GATED LIVE (`CONFORMANCE=1`, real installed binaries) | — |

The top-level [`test/corpus/README.md`](../corpus/README.md) already draws the
first line of that taxonomy — the vendored wire goldens are an offline check,
distinct from the gated live suite. The same line runs through this directory,
and the collision is sharper here: this corpus and `test/conformance.test.ts`
are told apart by a file extension. [`test/corpus/wire/README.md`](../corpus/wire/README.md)
states the general trap in one line — *"The wire corpus" ≠ "the conformance
suite."* — and the extra row above is its sequel: the conformance **corpus** is
not the conformance **suite** either.

---

*The canonical harness-wrapper README follows, verbatim.*

BANNER
  printf '%s\n' "$canonical" >> "$dir/README.md"
}

# Copy the corpus payload (*.json + README.md) from $1 to $2, preserving layout.
copy_corpus() {
  local src="$1" dest="$2"
  (
    cd "$src" &&
      find . -type f \( -name '*.json' -o -name 'README.md' \) |
      sed 's#^\./##' |
      LC_ALL=C sort |
      while IFS= read -r rel; do
        mkdir -p "$dest/$(dirname "$rel")"
        cp "$rel" "$dest/$rel"
      done
  )
}

mode="${1:-sync}"
case "$mode" in
  --check)
    [ -d "$corpus" ] || {
      echo "corpus not found: $corpus — run scripts/sync-conformance.sh" >&2
      exit 1
    }
    got="$(compute_manifest "$corpus")"
    if ! diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >/dev/null; then
      echo "FAIL: test/conformance/MANIFEST.sha256 is stale — re-run scripts/sync-conformance.sh" >&2
      diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >&2 || true
      exit 1
    fi
    echo "ok: test/conformance manifest is current"
    repo="${HARNESS_WRAPPER_REPO:-}"
    if [ -n "$repo" ] && [ -d "$repo/test/conformance" ]; then
      src="$repo/test/conformance"
      if ! diff -u "$src/MANIFEST.sha256" "$corpus/MANIFEST.sha256" >/dev/null; then
        echo "FAIL: test/conformance has DIVERGED from canonical ($src)" >&2
        diff -u "$src/MANIFEST.sha256" "$corpus/MANIFEST.sha256" >&2 || true
        exit 1
      fi
      echo "ok: test/conformance matches canonical $src"
    fi
    ;;

  --to)
    dest="${2:-}"
    [ -n "$dest" ] || {
      echo "usage: sync-conformance.sh --to DIR" >&2
      exit 2
    }
    [ -d "$corpus" ] || {
      echo "corpus not found: $corpus" >&2
      exit 1
    }
    mkdir -p "$dest"
    copy_corpus "$corpus" "$dest"
    # Mirror MANIFEST.sha256 too, so the other side can compare manifests.
    cp "$corpus/MANIFEST.sha256" "$dest/MANIFEST.sha256"
    echo "ok: mirrored test/conformance -> $dest"
    ;;

  sync)
    repo="${HARNESS_WRAPPER_REPO:-$HOME/Work/aether/harness-wrapper}"
    src="$repo/test/conformance"
    [ -d "$src" ] || {
      echo "canonical corpus not found: $src" >&2
      echo "set HARNESS_WRAPPER_REPO to the canonical harness-wrapper checkout" >&2
      exit 1
    }
    [ -f "$src/MANIFEST.sha256" ] || {
      echo "canonical manifest missing: $src/MANIFEST.sha256" >&2
      echo "regenerate it there with: make regen-conformance" >&2
      exit 1
    }
    rm -rf "$corpus"
    mkdir -p "$corpus"
    copy_corpus "$src" "$corpus"
    prepend_readme_banner "$corpus"
    # Copy the canonical manifest VERBATIM, then recompute ours over the copied
    # bytes and fail if they differ — the parity assertion the header describes.
    cp "$src/MANIFEST.sha256" "$corpus/MANIFEST.sha256"
    got="$(compute_manifest "$corpus")"
    if ! diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >/dev/null; then
      echo "FAIL: recomputed manifest differs from the canonical MANIFEST.sha256." >&2
      echo "Either the canonical manifest is stale (re-run 'make regen-conformance'" >&2
      echo "there) or the manifest conventions have diverged — see this script's header." >&2
      diff -u "$corpus/MANIFEST.sha256" <(printf '%s\n' "$got") >&2 || true
      exit 1
    fi
    echo "ok: vendored test/conformance from $src (manifest parity verified)"
    ;;

  *)
    echo "unknown mode: $mode (expected --check or --to)" >&2
    exit 2
    ;;
esac
