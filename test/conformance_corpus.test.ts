// Consumer of the vendored cross-language CONFORMANCE corpus (test/conformance/)
// — the language-neutral frozen JSON contracts harness-wrapper regenerates
// (`make regen-conformance`) and this repo only vendors. Sibling of
// test/wire_corpus.test.ts, and OFFLINE like it: this suite never launches a
// harness binary and is NOT gated on CONFORMANCE=1.
//
// Three artifacts, three different things — do not merge them:
//   • test/conformance/       (this)  vendored cross-language corpus, offline
//   • test/corpus/wire/               vendored wire goldens, offline
//   • test/conformance.test.ts        the GATED LIVE suite (CONFORMANCE=1, real
//                                     installed binaries) — a different artifact
//
// What this test guards:
//   1. Manifest integrity — the vendored MANIFEST.sha256 is current for the
//      vendored bytes, so drift fails in CI here the same way
//      harness-wrapper/scripts/check-conformance-corpus.sh fails it on the Go
//      side (that script compares the two MANIFEST.sha256 files).
//   2. Corpus self-consistency — every example instance conforms to the neutral
//      `fields.json` contract that ships beside it.
//   3. The CLI pins — cli/exit_codes.json is the ONE frozen exit-code table and
//      must equal our src/turnproto exports.
//
// MANIFEST CONVENTION: Go's computeManifest hashes `*.json` and NOTHING else, so
// the walk here must filter to `.json` too (README.md is deliberately unhashed).
// helpers/corpus.ts::computeManifest takes an EXCLUDE set rather than an include
// filter, so we derive the exclusions from the tree — see MANIFEST_EXCLUDE.
// scripts/sync-conformance.sh's header documents why this corpus does not follow
// harness-wrapper/scripts/sync-permission-mode-corpus.sh's third convention.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  DeadlineLine,
  ExitDeadline,
  ExitError,
  ExitOK,
  ExitUsage,
  parseLastJSONLine,
} from "../src/turnproto/index.ts";

import { computeManifest, readJSON, walkFiles } from "./helpers/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "conformance");

/** Corpus-relative posix path for an absolute file under CORPUS. */
const rel = (abs: string): string =>
  relative(CORPUS, abs).split(/[\\/]/).join("/");

/** Every file in the vendored tree, corpus-relative. */
const ALL_FILES = walkFiles(CORPUS).map(rel);

/** Every `*.json` file — exactly what Go's computeManifest walks. */
const JSON_FILES = ALL_FILES.filter((f) => f.endsWith(".json")).filter(
  (f) => f !== "MANIFEST.sha256",
);

// Everything the manifest does NOT hash: MANIFEST.sha256 itself plus every
// non-JSON file (today just README.md). Expressed as an exclude set because that
// is the shape helpers/corpus.ts::computeManifest accepts.
const MANIFEST_EXCLUDE = new Set(
  ALL_FILES.filter((f) => !f.endsWith(".json") || f === "MANIFEST.sha256"),
);

// ── Manifest drift guard ─────────────────────────────────────────────────────

describe("conformance corpus — manifest integrity", () => {
  test("MANIFEST.sha256 is current for the vendored bytes", () => {
    const recomputed = computeManifest(CORPUS, MANIFEST_EXCLUDE);
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    expect(recomputed).toBe(onDisk);
  });

  test("every listed file hashes to its manifest entry", () => {
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8").trim();
    for (const listed of onDisk.split("\n")) {
      const [hash, path] = listed.split(/\s+/);
      const actual = createHash("sha256")
        .update(readFileSync(join(CORPUS, path)))
        .digest("hex");
      expect(actual, path).toBe(hash);
    }
  });

  test("the manifest lists every corpus .json and nothing else", () => {
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8").trim();
    const listed = onDisk.split("\n").map((l) => l.split(/\s+/)[1]);
    expect([...listed].sort()).toEqual([...JSON_FILES].sort());
    // README.md ships with the corpus but is deliberately unhashed — the Go walk
    // is *.json only. Sanity-check both halves of that statement.
    expect(ALL_FILES).toContain("README.md");
    expect(listed).not.toContain("README.md");
  });

  test("no generator sources were vendored (the corpus is data, not Go)", () => {
    expect(ALL_FILES.filter((f) => f.endsWith(".go"))).toEqual([]);
  });
});

// ── Neutral field contract vs. the example instances ─────────────────────────
// fields.json describes each DTO as an ordered [{name, json_tag, type, optional}]
// list; the sibling `<DTO>.<case>.json` files are example instances of it. Every
// instance must carry every required tag and no tag outside the contract — the
// same present/absent freeze the Go side asserts, checked here on the vendored
// bytes so a partial sync cannot land silently.

interface NeutralField {
  name: string;
  json_tag: string;
  type: string;
  optional: boolean;
}

type FieldsFile = Record<string, NeutralField[]>;

/** Load `<subdir>/fields.json` and the example instances beside it. */
function loadSurface(subdir: string): {
  fields: FieldsFile;
  instances: { name: string; dto: string; value: Record<string, unknown> }[];
} {
  const root = join(CORPUS, subdir);
  const fields = readJSON(join(root, "fields.json")) as FieldsFile;
  const instances = walkFiles(root)
    .filter((f) => f.endsWith(".json") && basename(f) !== "fields.json")
    .map((f) => ({
      name: rel(f),
      // "<DTO>.<case>.json" -> "<DTO>"
      dto: basename(f).split(".")[0],
      value: readJSON(f) as Record<string, unknown>,
    }));
  return { fields, instances };
}

for (const subdir of ["gateway", "turnresult"]) {
  describe(`conformance corpus — ${subdir}/fields.json contract`, () => {
    const { fields, instances } = loadSurface(subdir);

    test("fields.json declares at least one DTO, each with typed fields", () => {
      expect(Object.keys(fields).length).toBeGreaterThan(0);
      for (const [dto, spec] of Object.entries(fields)) {
        expect(spec.length, `${dto}: no fields`).toBeGreaterThan(0);
        for (const f of spec) {
          expect(typeof f.name, `${dto}.${f.name}`).toBe("string");
          expect(typeof f.json_tag, `${dto}.${f.name}: json_tag`).toBe("string");
          expect(typeof f.optional, `${dto}.${f.name}: optional`).toBe(
            "boolean",
          );
          expect(f.json_tag, `${dto}.${f.name}: json_tag`).not.toBe("");
        }
      }
    });

    test("at least one example instance ships for this surface", () => {
      expect(instances.length).toBeGreaterThan(0);
    });

    for (const inst of instances) {
      test(`${inst.name} conforms to fields.json[${inst.dto}]`, () => {
        const spec = fields[inst.dto];
        expect(spec, `${inst.name}: no fields.json entry for ${inst.dto}`)
          .toBeDefined();
        const tags = new Set(spec.map((f) => f.json_tag));
        const required = spec
          .filter((f) => !f.optional)
          .map((f) => f.json_tag);
        const got = Object.keys(inst.value);
        expect(
          got.filter((k) => !tags.has(k)),
          `${inst.name}: keys outside the contract`,
        ).toEqual([]);
        expect(
          required.filter((k) => !got.includes(k)),
          `${inst.name}: missing required keys`,
        ).toEqual([]);
      });
    }
  });
}

// ── StructuredTurnResult instances round-trip through our parser ─────────────

describe("conformance corpus — StructuredTurnResult goldens parse", () => {
  const root = join(CORPUS, "turnresult");
  const goldens = walkFiles(root).filter((f) =>
    basename(f).startsWith("StructuredTurnResult."),
  );

  test("the corpus ships StructuredTurnResult instances", () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  for (const g of goldens) {
    test(`parseLastJSONLine :: ${rel(g)}`, () => {
      const golden = readJSON(g) as Record<string, unknown>;
      // Emit it the way the guest does — one JSON line on stdout — and parse it
      // back. Round-trip through OUR parser, never a byte compare (§ "Comparison
      // semantics: structural, NOT byte-identity" in the corpus README).
      const parsed = parseLastJSONLine(JSON.stringify(golden) + "\n");
      expect(parsed).not.toBeNull();
      const p = parsed as unknown as Record<string, unknown>;
      expect(Object.keys(p).sort()).toEqual(Object.keys(golden).sort());
      expect(typeof p.status).toBe("string");
      expect(typeof p.reply).toBe("string");
      expect(typeof p.harnessSessionID).toBe("string");
      expect(Array.isArray(p.transcript_entries)).toBe(true);
      expect(typeof p.working_dir).toBe("string");
    });
  }
});

// ── CLI pins ─────────────────────────────────────────────────────────────────

describe("conformance corpus — CLI exit-code + deadline pins", () => {
  interface ExitCodes {
    ExitOK: number;
    ExitError: number;
    ExitUsage: number;
    ExitDeadline: number;
    deadline_line: string;
  }

  const codes = readJSON(join(CORPUS, "cli", "exit_codes.json")) as ExitCodes;

  test("cli/exit_codes.json equals the src/turnproto exports", () => {
    expect(ExitOK).toBe(codes.ExitOK);
    expect(ExitError).toBe(codes.ExitError);
    expect(ExitUsage).toBe(codes.ExitUsage);
    expect(ExitDeadline).toBe(codes.ExitDeadline);
    expect(DeadlineLine).toBe(codes.deadline_line);
  });

  test("cli/emit_pairing.json agrees with the exit-code table", () => {
    const pairing = readJSON(join(CORPUS, "cli", "emit_pairing.json")) as Record<
      string,
      { exit_code: number; stderr_anchor: string }
    >;
    expect(Object.keys(pairing).length).toBeGreaterThan(0);
    const known = new Set([
      codes.ExitOK,
      codes.ExitError,
      codes.ExitUsage,
      codes.ExitDeadline,
    ]);
    for (const [status, row] of Object.entries(pairing)) {
      expect(known.has(row.exit_code), `${status}: exit_code`).toBe(true);
      // Only the deadline row carries a stderr anchor, and it is DeadlineLine.
      expect(row.stderr_anchor, `${status}: stderr_anchor`).toBe(
        status === "deadline" ? DeadlineLine : "",
      );
    }
    expect(pairing.completed?.exit_code).toBe(ExitOK);
    expect(pairing.deadline?.exit_code).toBe(ExitDeadline);
    expect(pairing.errored?.exit_code).toBe(ExitError);
  });

  test("every emit_pairing status has a StructuredTurnResult golden", () => {
    const pairing = readJSON(join(CORPUS, "cli", "emit_pairing.json")) as Record<
      string,
      unknown
    >;
    const statuses = new Set(
      walkFiles(join(CORPUS, "turnresult"))
        .filter((f) => basename(f).startsWith("StructuredTurnResult."))
        .map((f) => (readJSON(f) as { status: string }).status),
    );
    for (const status of Object.keys(pairing)) {
      expect(statuses.has(status), `${status}: no golden instance`).toBe(true);
    }
  });
});
