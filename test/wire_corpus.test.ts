// Consumer of the shared cross-language WIRE corpus (test/corpus/wire/) — the
// OFFLINE golden freeze for three frozen surfaces the MH port hand-duplicates
// against Go's harness-chatd / turnproto:
//
//   1. Gateway wire DTOs   (src/gateway/dto.ts  <-> Go cmd/harness-chatd/types.go)
//   2. StructuredTurnResult (src/turnproto/protocol.ts <-> Go pkg/turnproto)
//   3. CLI exit codes + DeadlineLine (the frozen literals in both repos)
//
// The corpus is VENDORED, byte-identical, from the canonical side
// (harness-wrapper, HARNESS-WRAPPER-47) via the sync script — exactly like the
// auth corpus. It is DISTINCT from test/conformance.test.ts (the gated LIVE
// suite that drives real installed binaries): this test runs offline against
// vendored goldens and never launches a harness.
//
// COMPARISON SEMANTICS — the DTO goldens are ONE canonical producer (Go) with
// SEMANTIC (never string) comparison on this consuming side, because Go's
// encoding/json and JSON.stringify can never agree byte-for-byte (HTML escaping,
// key order, and timestamp spelling: Go RFC3339 "…05Z" vs Date.toISOString()
// "…05.000Z"). The comparator therefore:
//   • compares the declared timestamp keys (started_at/completed_at/created_at)
//     as INSTANTS (Date.parse both sides), at EVERY nesting depth;
//   • deep-equals everything else;
//   • asserts EXACT key sets at every object level, so a timestamp key's
//     PRESENCE is still frozen even though its spelling is compared as an instant
//     — this is what catches omit-drift (a field that should have been dropped).
// Fixture instants are whole-second so JS millisecond Date can represent them.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  inputRequestDTO,
  parseAnswerRequest,
  screenResponse,
  sessionDTO,
  turnDTO,
  turnResultDTO,
} from "../src/gateway/dto.ts";
import type { AnswerRequestBody } from "../src/gateway/dto.ts";
import type { InputRequest, Session, Turn } from "../src/chat/types.ts";
import type { Snapshot } from "../src/screen/screen.ts";
import type { TurnResult } from "../src/harness/index.ts";
import {
  DeadlineLine,
  ExitDeadline,
  ExitError,
  ExitOK,
  ExitUsage,
  parseLastJSONLine,
  type StructuredTurnResult,
} from "../src/turnproto/index.ts";

import { computeManifest, readJSON, walkFiles } from "./helpers/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "corpus", "wire");

// Files the manifest deliberately does not freeze (docs + itself).
const MANIFEST_EXCLUDE = new Set(["MANIFEST.sha256", "README.md"]);

// ── Fixture loading ──────────────────────────────────────────────────────────

interface Meta {
  surface: string;
  description: string;
  scope?: string;
  input: unknown;
}

interface Fixture {
  name: string; // corpus-relative dir, e.g. "dto/turn-minimal"
  meta: Meta;
  golden: unknown;
}

/** Load every fixture dir (a meta.json + golden.json pair) under the corpus. */
function loadFixtures(): Fixture[] {
  const metas = walkFiles(CORPUS, MANIFEST_EXCLUDE).filter((f) =>
    f.endsWith("meta.json"),
  );
  return metas.map((metaPath) => {
    const dir = dirname(metaPath);
    return {
      name: dir
        .slice(CORPUS.length + 1)
        .split(/[\\/]/)
        .join("/"),
      meta: readJSON(metaPath) as Meta,
      golden: readJSON(join(dir, "golden.json")),
    };
  });
}

const FIXTURES = loadFixtures();
const bySurface = (s: string): Fixture[] =>
  FIXTURES.filter((f) => f.meta.surface === s);

// ── Timestamp-aware semantic comparator ──────────────────────────────────────

// The keys whose VALUES are timestamp strings — compared as instants, not text.
// Applied at EVERY nesting depth (TurnResult nests turn/session/history[]).
const TIMESTAMP_KEYS = new Set(["started_at", "completed_at", "created_at"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * assertSemantic deep-compares `actual` (converter output) against `golden`,
 * comparing declared timestamp keys as instants and asserting exact key sets at
 * each object level. `path` is threaded only for failure messages.
 */
function assertSemantic(actual: unknown, golden: unknown, path: string): void {
  if (isPlainObject(golden)) {
    expect(isPlainObject(actual), `${path}: expected an object`).toBe(true);
    const a = actual as Record<string, unknown>;
    // Exact key-set freeze at this level — catches both silent additions and
    // omit-drift (a field that should have been dropped but was not).
    expect(Object.keys(a).sort(), `${path}: key set`).toEqual(
      Object.keys(golden).sort(),
    );
    for (const k of Object.keys(golden)) {
      const childPath = path ? `${path}.${k}` : k;
      if (TIMESTAMP_KEYS.has(k)) {
        const ta = Date.parse(a[k] as string);
        const tg = Date.parse(golden[k] as string);
        expect(
          Number.isFinite(ta),
          `${childPath}: actual not a timestamp`,
        ).toBe(true);
        expect(
          Number.isFinite(tg),
          `${childPath}: golden not a timestamp`,
        ).toBe(true);
        expect(ta, `${childPath}: instant`).toBe(tg);
      } else {
        assertSemantic(a[k], golden[k], childPath);
      }
    }
    return;
  }
  if (Array.isArray(golden)) {
    expect(Array.isArray(actual), `${path}: expected an array`).toBe(true);
    const a = actual as unknown[];
    expect(a.length, `${path}: length`).toBe(golden.length);
    golden.forEach((g, i) => {
      assertSemantic(a[i], g, `${path}[${String(i)}]`);
    });
    return;
  }
  expect(actual, `${path}: scalar`).toEqual(golden);
}

// ── Input builders (meta.json input -> native MH value) ──────────────────────

interface TurnInput {
  id: string;
  sessionID: string;
  role: string;
  state: string;
  text: string;
  reason: string;
  startedAt: string | null;
  completedAt: string | null;
  httpCode: number;
  retryAfter: number;
}

/** null instant -> new Date(0) (the "not yet complete" / zero sentinel). */
function toDate(v: string | null): Date {
  return v == null ? new Date(0) : new Date(v);
}

function buildTurn(input: TurnInput): Turn {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: input.role as Turn["role"],
    state: input.state as Turn["state"],
    text: input.text,
    reason: input.reason,
    startedAt: toDate(input.startedAt),
    completedAt: toDate(input.completedAt),
    httpCode: input.httpCode,
    retryAfter: input.retryAfter,
  };
}

interface SessionInput {
  id: string;
  harness: string;
  workingDir: string;
  createdAt: string;
  harnessSessionID: string;
}

function buildSession(input: SessionInput): Session {
  return {
    id: input.id,
    harness: input.harness,
    workingDir: input.workingDir,
    createdAt: new Date(input.createdAt),
    harnessSessionID: input.harnessSessionID,
  };
}

// ── DTO serialize surfaces ───────────────────────────────────────────────────

describe("wire corpus — gateway DTO goldens (semantic, Go-produced)", () => {
  for (const f of bySurface("turn")) {
    test(`turnDTO :: ${f.name}`, () => {
      const out = turnDTO(buildTurn(f.meta.input as TurnInput));
      assertSemantic(out, f.golden, f.name);
    });
  }

  for (const f of bySurface("session")) {
    test(`sessionDTO :: ${f.name}`, () => {
      const out = sessionDTO(buildSession(f.meta.input as SessionInput));
      assertSemantic(out, f.golden, f.name);
    });
  }

  for (const f of bySurface("inputRequest")) {
    test(`inputRequestDTO :: ${f.name}`, () => {
      const out = inputRequestDTO(f.meta.input as InputRequest);
      assertSemantic(out, f.golden, f.name);
    });
  }

  for (const f of bySurface("screen")) {
    test(`screenResponse :: ${f.name}`, () => {
      const out = screenResponse(f.meta.input as Snapshot);
      assertSemantic(out, f.golden, f.name);
    });
  }

  for (const f of bySurface("turnResult")) {
    test(`turnResultDTO :: ${f.name}`, () => {
      const inp = f.meta.input as {
        turn: TurnInput;
        session: SessionInput;
        history: TurnInput[];
        historySource: string;
        processStoppedAfterTurn: boolean;
      };
      const result: TurnResult = {
        turn: buildTurn(inp.turn),
        session: buildSession(inp.session),
        history: inp.history.map(buildTurn),
        historySource: inp.historySource as TurnResult["historySource"],
        processStoppedAfterTurn: inp.processStoppedAfterTurn,
      };
      assertSemantic(turnResultDTO(result), f.golden, f.name);
    });
  }
});

// ── answerRequest deserialize surface ────────────────────────────────────────
// Freezes parseAnswerRequest's edge semantics: both ids pass through, empty
// option_ids[] drops (length > 0), empty option_id drops (falsy), empty text is
// KEPT (!== undefined). golden.json is the expected MH InputAnswer.

describe("wire corpus — answerRequest deserialize goldens", () => {
  for (const f of bySurface("answerRequest")) {
    test(`parseAnswerRequest :: ${f.name}`, () => {
      const out = parseAnswerRequest(f.meta.input as AnswerRequestBody);
      expect(out).toEqual(f.golden);
    });
  }
});

// ── StructuredTurnResult round-trip surface ──────────────────────────────────

describe("wire corpus — StructuredTurnResult goldens", () => {
  const TYPE_OF: Record<string, (v: unknown) => boolean> = {
    status: (v) => typeof v === "string",
    reply: (v) => typeof v === "string",
    harnessSessionID: (v) => typeof v === "string",
    transcript_entries: (v) => Array.isArray(v),
    working_dir: (v) => typeof v === "string",
    usage: (v) => typeof v === "object" && v !== null,
    reason: (v) => typeof v === "string",
    transcript_error: (v) => typeof v === "string",
    // Landed AHEAD of its fixture (META-HARNESS-129 Half C). This map is OURS,
    // not vendored, while structured/permission-mode has to originate in
    // HARNESS_WRAPPER_REPO and arrive via `scripts/sync-corpus.sh wire` — so the
    // sync stays a pure vendor operation. An entry with no fixture is inert;
    // MISSING one is not, because TYPE_OF[k] would be undefined and TYPE_OF[k](…)
    // below THROWS instead of failing cleanly. `string`, never an enum: a newer
    // producer's value must cross opaquely rather than be mapped onto a rung.
    permission_mode: (v) => typeof v === "string",
  };

  for (const f of bySurface("structuredResult")) {
    test(`parseLastJSONLine :: ${f.name}`, () => {
      const sample = f.meta.input as StructuredTurnResult;
      const line = JSON.stringify(sample) + "\n";
      const parsed = parseLastJSONLine(line);
      expect(parsed).not.toBeNull();
      const p = parsed as unknown as Record<string, unknown>;
      const expectedKeys = (f.golden as { keys: string[] }).keys;
      expect(Object.keys(p).sort()).toEqual([...expectedKeys].sort());
      for (const k of expectedKeys) {
        expect(TYPE_OF[k](p[k]), `${f.name}: ${k} type`).toBe(true);
      }
    });
  }
});

// ── Constants freeze (values, not emission) ──────────────────────────────────

describe("wire corpus — exit-code + DeadlineLine constants", () => {
  test("constants.json equals the src/turnproto exports", () => {
    const c = readJSON(join(CORPUS, "constants.json")) as {
      exit_ok: number;
      exit_error: number;
      exit_usage: number;
      exit_deadline: number;
      deadline_line: string;
    };
    expect(ExitOK).toBe(c.exit_ok);
    expect(ExitError).toBe(c.exit_error);
    expect(ExitUsage).toBe(c.exit_usage);
    expect(ExitDeadline).toBe(c.exit_deadline);
    expect(DeadlineLine).toBe(c.deadline_line);
  });
});

// ── Manifest drift guard ─────────────────────────────────────────────────────
// Proves the vendored bytes have not drifted from MANIFEST.sha256 — identical
// discipline to the auth corpus. (Cross-REPO divergence between two internally
// consistent manifests is NOT caught here; the sync script's --check mode is.)

describe("wire corpus — manifest integrity", () => {
  test("MANIFEST.sha256 is current for the vendored bytes", () => {
    const recomputed = computeManifest(CORPUS, MANIFEST_EXCLUDE);
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    expect(recomputed).toBe(onDisk);
  });

  test("every listed file hashes to its manifest entry", () => {
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8").trim();
    for (const listed of onDisk.split("\n")) {
      const [hash, rel] = listed.split(/\s+/);
      const actual = createHash("sha256")
        .update(readFileSync(join(CORPUS, rel)))
        .digest("hex");
      expect(actual, rel).toBe(hash);
    }
  });
});
