// Offline permission-mode corpus conformance — the TS half of the cross-language
// contract for the permission-posture signal.
//
// test/corpus/permission-mode/ is VENDORED, byte-identically, from
// harness-wrapper (canonical: it is where the screens were captured, and its
// README states the direction is harness-wrapper -> meta-harness). Never edit
// the bytes here; regenerate with
//
//     HARNESS_WRAPPER_REPO=<checkout> scripts/sync-corpus.sh permission-mode
//
// The two repos are in sync IFF their committed MANIFEST.sha256 files are
// byte-equal, which is why this corpus follows the CANONICAL generator's
// manifest convention: every file but MANIFEST.sha256 is hashed, README.md
// INCLUDED (harness-wrapper/scripts/sync-permission-mode-corpus.sh::gen_manifest;
// see scripts/sync-corpus.sh's readme_hashed()). That is also why the vendored
// README.md carries no "VENDORED COPY" banner — a banner would break byte
// equality by construction.
//
// Go's half is pkg/chat/permission_mode_corpus_test.go, which drives the same
// bytes through the real adapters.

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { parsePermissionMode, type PermissionRung } from "../../src/chat/index.ts";

import { computeManifest, readJSON, walkFiles } from "../helpers/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../corpus/permission-mode");

/**
 * Go rung name -> TS rung name. The two ladders spell one rung differently:
 * the corpus's `meta.mode` is the GO vocabulary (pkg/turns/harness/claudecode/
 * permmode.go), where the "accept edits on" footer is `ask`, while this repo
 * calls it `acceptEdits` (claudeFooterRungs, src/chat/permission.ts). Every
 * other rung name is identical. The divergence is real and pre-existing; it is
 * translated here explicitly rather than aliased away.
 */
const GO_RUNG_TO_TS = { ask: "acceptEdits" } as const;

/** The closed 5-rung ladder, as this repo spells it. */
const TS_RUNGS = new Set<string>([
  "plan",
  "manual",
  "acceptEdits",
  "auto",
  "bypass",
]);

/** meta.mode -> the rung THIS repo should report, or undefined if off-ladder. */
function tsRungFor(goMode: string): PermissionRung | undefined {
  const name: string =
    (GO_RUNG_TO_TS as Record<string, string>)[goMode] ?? goMode;
  return TS_RUNGS.has(name) ? (name as PermissionRung) : undefined;
}

/**
 * Go rungs that have NO TS counterpart yet, mapped to the footer fragment this
 * repo reports instead (`observed: "unknown"` + verbatim `raw` — an off-ladder
 * state, deliberately NOT a failure to see; src/chat/permission.ts).
 *
 * Empty today: every rung the corpus records has a TS counterpart. It is the
 * companion of the `meta.pending_parser` branch below — a future capture whose
 * Go rung this repo cannot name gets its footer fragment here, and the branch
 * fails loudly rather than passing, if it is forgotten.
 */
const OFF_LADDER_RAW: Record<string, string> = {};

/**
 * The meta-harness half of the pending-parser inversion, for the window in
 * which the two repos' parsers disagree in the OTHER direction.
 *
 * `meta.pending_parser` is CANONICAL's marker: it says harness-wrapper's own
 * parser cannot yet read the captured screen. This map says the opposite —
 * canonical has landed the fix and the corpus now records the settled rung,
 * while THIS repo's reader has not caught up. Vendoring the bytes must not wait
 * on that, and it must not silently assert the stale behaviour either, so the
 * entry carries the same inversion semantics: it asserts the parser still
 * DISAGREES and goes red the moment it starts agreeing, which forces the entry
 * to be deleted in the very change that fixes the reader.
 *
 * TODO(PUPPET-512): claude's `dontAsk` paints a sixth footer word,
 * `⏵⏵ don't ask on`, on the EXISTING `manual` rung (harness-wrapper
 * origin/main d6eb85f promoted `claude-code/dont-ask` from `pending_parser` to
 * `"mode": "manual"`). `claudeFooterRungs` in src/chat/permission.ts has no
 * `"don't ask on"` key yet, so this repo reports the fragment verbatim as an
 * off-ladder reading. PUPPET-512 adds that key; do NOT add it here — this
 * ticket vendors bytes only.
 */
const TS_PENDING_PARSER: Record<string, { raw: string; ticket: string }> = {
  "claude-code/dont-ask": { raw: "don't ask on", ticket: "PUPPET-512" },
};

interface Meta {
  harness: string;
  mode: string;
  /**
   * Present iff the CAPTURED screen is one the parser does not yet read
   * correctly. Canonical semantics (test/corpus/permission-mode/README.md): the
   * marker cannot outlive the fix it names — a case carrying it asserts the
   * parser DISAGREES and goes red the moment it starts agreeing, forcing the
   * field to be dropped in the same change that fixes the parser.
   */
  pending_parser?: string;
}

const rel = (p: string): string => relative(CORPUS, p).split(sep).join("/");

const cases = walkFiles(CORPUS)
  .filter((p) => p.endsWith(`${sep}meta.json`))
  .map((metaPath) => {
    const dir = dirname(metaPath);
    // Only screen.txt and meta.json are read as text: bytes.raw is a binary
    // capture and is not valid UTF-8. It is hashed (as a Buffer) by the
    // manifest guard and never decoded.
    return {
      name: rel(dir),
      meta: readJSON(metaPath) as Meta,
      screen: readFileSync(join(dir, "screen.txt"), "utf8"),
    };
  })
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const claudeCases = cases.filter((c) => c.meta.harness === "claude-code");
const codexCases = cases.filter((c) => c.meta.harness === "codex");

describe("permission-mode corpus", () => {
  // Guards against an empty walk (a moved/renamed corpus) silently passing
  // every data-driven assertion below.
  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(claudeCases.length).toBeGreaterThan(0);
    expect(codexCases.length).toBeGreaterThan(0);
  });

  // THE DRIFT GUARD, and the one assertion here that is conditional on nothing:
  // it is what makes the vendored bytes equal to canonical's in CI, the same
  // check scripts/sync-corpus.sh permission-mode --check runs.
  test("MANIFEST.sha256 is current", () => {
    const want = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    // README.md is IN: this corpus is the canonical generator's convention.
    expect(computeManifest(CORPUS, new Set(["MANIFEST.sha256"]))).toBe(want);
  });
});

describe("claude-code footer conformance", () => {
  for (const c of claudeCases) {
    test(`parsePermissionMode(${c.name})`, () => {
      // Argument order is (text, harness) — src/chat/permission.ts.
      const reading = parsePermissionMode(c.screen, "claude-code");
      expect(reading, `${c.name}: claude-code must have a reader`).not.toBeNull();

      const want = tsRungFor(c.meta.mode);

      if (c.meta.pending_parser) {
        // Inversion: assert the parser still DISAGREES, so dropping the marker
        // is forced by a red test rather than remembered.
        if (want === undefined) {
          const raw = OFF_LADDER_RAW[c.meta.mode];
          expect(
            raw,
            `${c.name}: meta.mode "${c.meta.mode}" has no TS rung and no ` +
              `OFF_LADDER_RAW entry — extend GO_RUNG_TO_TS (if the rung landed) ` +
              `or OFF_LADDER_RAW (if it is still off-ladder)`,
          ).toBeDefined();
          expect(reading?.observed).toBe("unknown");
          expect(reading?.raw).toBe(raw);
          expect(reading?.source).toBe("footer");
        } else {
          expect(
            reading?.observed,
            `${c.name}: parser now AGREES with meta.mode — drop meta.pending_parser`,
          ).not.toBe(want);
        }
        return;
      }

      expect(
        want,
        `${c.name}: unknown meta.mode "${c.meta.mode}" — a Go rung with no TS ` +
          `counterpart. Extend GO_RUNG_TO_TS deliberately; do not let it pass.`,
      ).toBeDefined();

      const pending = TS_PENDING_PARSER[c.name];
      if (pending) {
        // Inversion, mirroring meta.pending_parser but for THIS repo's reader:
        // canonical has settled the rung, we have not read it yet.
        expect(
          reading?.observed,
          `${c.name}: this repo's reader now AGREES with meta.mode ` +
            `"${c.meta.mode}" — drop the TS_PENDING_PARSER entry ` +
            `(${pending.ticket} has landed)`,
        ).not.toBe(want);
        expect(reading?.observed).toBe("unknown");
        expect(reading?.raw).toBe(pending.raw);
        expect(reading?.source).toBe("footer");
        return;
      }

      expect(reading?.observed).toBe(want);
    });
  }
});

// The codex fixtures are COMPOSER-GUTTER screens: Go reads the gutter marker
// (pkg/turns/harness/codex/permmode.go's collaborationPlanRE), while this repo
// reads the collaboration axis only from a `/status` box row
// (parseCodexStatus, src/chat/permission.ts) and has no gutter reader at all.
// So both fixtures currently read as fully unknown. That parity gap is real and
// out of scope for the vendoring; these assertions PIN today's behaviour so a
// future TS gutter reader trips this test and its expectations get written
// deliberately rather than absorbed silently.
describe("codex cases are vendored but unread here", () => {
  for (const c of codexCases) {
    test(`parsePermissionMode(${c.name}) is unknown on both axes`, () => {
      const reading = parsePermissionMode(c.screen, "codex");
      expect(reading).not.toBeNull();
      expect(reading?.observed).toBe("unknown");
      expect(reading?.collaboration).toBe("unknown");
      expect(reading?.source).toBe("status");
      // meta.mode records what GO reads from the same bytes.
      expect(c.meta.mode).toBe("plan");
    });
  }
});
