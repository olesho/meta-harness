// Consumer of the vendored PERMISSION-MODE corpus (test/corpus/permission-mode/)
// — real captured footer/`/status` screens paired with the posture a parser must
// read off them. Sibling of test/conformance_corpus.test.ts and
// test/wire_corpus.test.ts, and OFFLINE like both: this suite never launches a
// harness binary and is NOT gated on CONFORMANCE=1.
//
// The corpus is CAPTURED in harness-wrapper (canonical for shared corpora) and
// mirrored here byte-identically by that repo's
// `scripts/sync-permission-mode-corpus.sh --to <this repo>`. The two repos are
// "in sync" iff their committed test/corpus/permission-mode/MANIFEST.sha256 are
// BYTE-EQUAL, so the only thing this file may assert about the manifest is that
// it recomputes to the vendored bytes — never a locally-invented convention.
//
// MANIFEST CONVENTION: this corpus follows the THIRD convention in the family
// (scripts/sync-conformance.sh's header enumerates all three). Its generator
// hashes every file under the corpus root EXCEPT MANIFEST.sha256 itself, which
// means README.md IS hashed — unlike the wire corpus (convention 2, README.md
// excluded) and unlike the Go conformance corpus (convention 1, `*.json` only).
// Do NOT harmonise the exclude set with the sibling suites: dropping README.md
// here would make our manifest un-reproducible from the canonical generator and
// the cross-repo byte-equality invariant would fail forever.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { computeManifest, readJSON, walkFiles } from "./helpers/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "corpus", "permission-mode");

// Convention 3: everything except the manifest itself. README.md stays IN.
const MANIFEST_EXCLUDE = new Set(["MANIFEST.sha256"]);

/** Corpus-relative posix path for an absolute file under CORPUS. */
const rel = (abs: string): string =>
  relative(CORPUS, abs).split(/[\\/]/).join("/");

const ALL_FILES = walkFiles(CORPUS, MANIFEST_EXCLUDE).map(rel);

describe("permission-mode corpus — manifest integrity", () => {
  test("MANIFEST.sha256 is current for the vendored bytes", () => {
    const recomputed = computeManifest(CORPUS, MANIFEST_EXCLUDE);
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    expect(recomputed).toBe(onDisk);
  });

  test("every listed file hashes to its manifest entry", () => {
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8").trim();
    const listed = onDisk.split("\n").map((line) => {
      const [hash, path] = line.split("  ");
      return { hash, path };
    });
    for (const { hash, path } of listed) {
      const actual = createHash("sha256")
        .update(readFileSync(join(CORPUS, path)))
        .digest("hex");
      expect(actual, path).toBe(hash);
    }
    // The manifest lists the WHOLE tree, not a subset — a file added to the
    // mirror without re-running the sync script must fail here too.
    expect(listed.map((e) => e.path).sort()).toEqual([...ALL_FILES].sort());
  });

  test("README.md is hashed — this corpus follows the third convention", () => {
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    expect(onDisk).toContain("  README.md\n");
  });
});

// ── Corpus shape ─────────────────────────────────────────────────────────────
//
// This repo VENDORS the corpus; harness-wrapper's Go suite is the one that
// drives every capture through a parser. What is asserted here is the shape the
// mirror must keep, plus the one case this port's own defect was about.

interface PermModeMeta {
  harness: string;
  binary_version: string;
  recorded_at: string;
  cols: number;
  rows: number;
  mode: string;
  pending_parser?: string;
  notes: string;
}

const metaFiles = ALL_FILES.filter((f) => f.endsWith("/meta.json"));

describe("permission-mode corpus — vendored shape", () => {
  test("every case carries meta.json + screen.txt and a non-empty mode", () => {
    expect(metaFiles.length).toBeGreaterThan(0);
    for (const m of metaFiles) {
      const meta = readJSON(join(CORPUS, m)) as PermModeMeta;
      expect(meta.harness, m).toBeTruthy();
      expect(meta.mode, m).toBeTruthy();
      expect(meta.cols, m).toBeGreaterThan(0);
      expect(meta.rows, m).toBeGreaterThan(0);
      expect(ALL_FILES, m).toContain(m.replace(/meta\.json$/, "screen.txt"));
    }
  });

  test("the claude-code dont-ask capture reports the manual rung, with no pending_parser marker left", () => {
    // The capture this port's defect was about: claude paints a SIXTH footer
    // word for `--permission-mode dontAsk`, and it reports the EXISTING `manual`
    // rung (claude's own permissiveness rank table ties dontAsk with default),
    // so no sixth rung is added. `pending_parser` marked the canonical repo's
    // gap and is deleted the moment the parser reads the capture — the two
    // repos land that deletion as one change-set.
    const meta = readJSON(
      join(CORPUS, "claude-code/dont-ask/meta.json"),
    ) as PermModeMeta;
    expect(meta.mode).toBe("manual");
    expect(meta.pending_parser).toBeUndefined();
  });

  test("the dont-ask capture's footer is the one this repo's parser must read", () => {
    const screen = readFileSync(
      join(CORPUS, "claude-code/dont-ask/screen.txt"),
      "utf8",
    );
    expect(screen).toContain("don't ask on");
  });
});
