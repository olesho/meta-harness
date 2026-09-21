// Consumer of the vendored API-ERROR TAG corpus (test/corpus/apierror/) — real
// synthetic-API-error lines lifted out of Claude Code session transcripts, each
// paired with the verdict the tag mapping must reach. OFFLINE: no harness binary.
//
// The corpus is CAPTURED in harness-wrapper (canonical) and mirrored here
// byte-identically by that repo's `scripts/sync-apierror-corpus.sh --to <this
// repo>`. The two repos are in sync iff their committed MANIFEST.sha256 are
// BYTE-EQUAL, so the manifest assertion below only checks that it recomputes to
// the vendored bytes — never a locally-invented convention.
//
// MANIFEST CONVENTION 3 (as permission-mode): every file under the corpus root
// except MANIFEST.sha256 itself is hashed — README.md IS in. Do not harmonise the
// exclude set with the wire corpus (convention 2); the cross-repo byte-equality
// invariant would fail forever.
//
// Every fixture is driven through the REAL parser path — parseFromBytes → claude
// events → turnsFromEvents → apiErrorVerdictFrom — never a hand-built turn, so
// this pins exactly what a live transcript read produces.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { computeManifest, readJSON } from "../helpers/corpus.ts";
import {
  apiErrorDetailCap,
  apiErrorVerdictFrom,
  oneLineCapped,
  turnReason,
} from "../../src/chat/apierror.ts";
import {
  CodeAuthRequired,
  CodeBillingWall,
  CodeUsageLimited,
  ReasonAuthRequired,
  ReasonBillingWall,
  ReasonUsageLimited,
} from "../../src/chat/index.ts";
import {
  apiErrorTagOf,
  events,
} from "../../src/transcript/claudecode/parseClaude.ts";
import { toPublicJSON, turnsFromEvents } from "../../src/transcript/event.ts";
import { parseFromBytes } from "../../src/transcript/parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "..", "corpus", "apierror");
const MANIFEST_EXCLUDE = new Set(["MANIFEST.sha256"]);

interface Meta {
  harness: string;
  tag: string;
  verdict: "wall" | "errored" | "none";
  code: string;
  reason: string;
  screenOnly: string;
  screenAuthRequired: boolean;
  occurrences: number;
  versions: string[];
}

// The Go reason constant each fixture's `reason` names, mapped to our copy.
const REASONS: Record<string, string> = {
  ReasonAuthRequired,
  ReasonBillingWall,
  ReasonUsageLimited,
};
const CODES: Record<string, string> = {
  auth_required: CodeAuthRequired,
  billing_wall: CodeBillingWall,
  usage_limited: CodeUsageLimited,
};

const CASES = readdirSync(join(CORPUS, "claude-code"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function turnsOf(jsonl: string) {
  return turnsFromEvents(events(jsonl));
}

describe("apierror corpus — manifest integrity", () => {
  test("MANIFEST.sha256 is current for the vendored bytes", () => {
    const recomputed = computeManifest(CORPUS, MANIFEST_EXCLUDE);
    const onDisk = readFileSync(join(CORPUS, "MANIFEST.sha256"), "utf8");
    expect(recomputed).toBe(onDisk);
  });

  test("the corpus holds the 19 captured shapes", () => {
    expect(CASES).toHaveLength(19);
  });
});

describe("apierror corpus — every captured line reaches its recorded verdict", () => {
  for (const name of CASES) {
    test(name, () => {
      const dir = join(CORPUS, "claude-code", name);
      const meta = readJSON(join(dir, "meta.json")) as Meta;
      const jsonl = readFileSync(join(dir, "line.jsonl"), "utf8");

      // Parser: the tag is read off the line, gated on isApiErrorMessage.
      const [line] = parseFromBytes(jsonl);
      expect(apiErrorTagOf(line)).toBe(meta.tag);

      const turns = turnsOf(jsonl);
      expect(turns).toHaveLength(1);
      expect(turns[0].apiError).toBe(meta.tag);

      const v = apiErrorVerdictFrom(turns, 0);
      switch (meta.verdict) {
        case "wall":
          expect(v).not.toBeNull();
          expect(v!.code).toBe(CODES[meta.code]);
          expect(v!.reason).toBe(REASONS[meta.reason]);
          break;
        case "errored":
          expect(v).not.toBeNull();
          expect(v!.code).toBeUndefined();
          expect(v!.reason).toBe("");
          break;
        case "none":
          expect(v).toBeNull();
          break;
      }
      if (v !== null) {
        const reason = turnReason(v, "claude-code");
        expect(reason).toContain(`harness tag: ${meta.tag}`);
        // The rendered error rides along as evidence, flattened to one line.
        expect(reason).not.toMatch(/[\n\r]/);
      }
    });
  }
});

// ── the three rules, on hand-shaped transcripts ─────────────────────────────

const U = (text: string) =>
  JSON.stringify({
    type: "user",
    uuid: "u-" + text,
    message: { role: "user", content: text },
  });
const A = (text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: "a-" + text,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text }],
    },
  });
const TAGGED = (tag: string, text = "API Error: something") =>
  JSON.stringify({
    type: "assistant",
    uuid: "t-" + tag,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
    isApiErrorMessage: true,
    error: tag,
  });
const jsonl = (...lines: string[]) => lines.join("\n") + "\n";

describe("apiErrorVerdictFrom — the rules", () => {
  test("LAST WORD ONLY: a tag followed by a real reply is a recovered turn", () => {
    const turns = turnsOf(
      jsonl(U("q"), TAGGED("overloaded"), A("the real answer")),
    );
    expect(apiErrorVerdictFrom(turns, 0)).toBeNull();
  });

  test("LAST WORD ONLY: a real reply followed by a tag is a failed turn", () => {
    const turns = turnsOf(jsonl(U("q"), A("partial"), TAGGED("billing_error")));
    expect(apiErrorVerdictFrom(turns, 0)?.code).toBe(CodeBillingWall);
  });

  test("CORRELATION: a tag before the watermark belongs to an earlier turn", () => {
    const turns = turnsOf(jsonl(U("old"), TAGGED("billing_error"), U("new")));
    // Watermark 2: only the new user turn is this turn's; no assistant entry yet.
    expect(apiErrorVerdictFrom(turns, 2)).toBeNull();
    // Watermark 0 would (wrongly, for this turn) reach the stale tag.
    expect(apiErrorVerdictFrom(turns, 0)?.code).toBe(CodeBillingWall);
  });

  test("an unknown watermark is a decline, never a zero", () => {
    const turns = turnsOf(jsonl(U("q"), TAGGED("billing_error")));
    expect(apiErrorVerdictFrom(turns, null)).toBeNull();
    expect(apiErrorVerdictFrom(turns, -1)).toBeNull();
  });

  test("NO GUESSING: unmapped tags yield no verdict", () => {
    for (const tag of [
      "invalid_request",
      "max_output_tokens",
      "unknown",
      "some_future_tag",
    ]) {
      const turns = turnsOf(jsonl(U("q"), TAGGED(tag)));
      expect(apiErrorVerdictFrom(turns, 0), tag).toBeNull();
    }
  });

  test("account_on_hold is BILLING, not auth; rate_limit is the usage wall", () => {
    expect(
      apiErrorVerdictFrom(turnsOf(jsonl(TAGGED("account_on_hold"))), 0)?.code,
    ).toBe(CodeBillingWall);
    expect(
      apiErrorVerdictFrom(turnsOf(jsonl(TAGGED("rate_limit"))), 0)?.code,
    ).toBe(CodeUsageLimited);
  });

  test("a hook result's `error` without isApiErrorMessage is not an API error", () => {
    const hook = JSON.stringify({
      type: "assistant",
      uuid: "h1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "done" }],
      },
      error: "policy_denied",
    });
    const [line] = parseFromBytes(hook + "\n");
    expect(apiErrorTagOf(line)).toBe("");
    const turns = turnsOf(jsonl(U("q"), hook));
    expect(turns.at(-1)!.apiError).toBeUndefined();
    expect(apiErrorVerdictFrom(turns, 0)).toBeNull();
  });
});

describe("turnReason / oneLineCapped", () => {
  test("a wall uses its canonical reason, with the tag and text as evidence", () => {
    const v = apiErrorVerdictFrom(
      turnsOf(jsonl(TAGGED("billing_error", "Credit balance is too low"))),
      0,
    )!;
    expect(turnReason(v, "claude-code")).toBe(
      `${ReasonBillingWall} (harness tag: billing_error; Credit balance is too low)`,
    );
  });

  test("a non-wall names the harness and carries no code", () => {
    const v = apiErrorVerdictFrom(
      turnsOf(jsonl(TAGGED("server_error", "API Error: 500"))),
      0,
    )!;
    expect(v.code).toBeUndefined();
    expect(turnReason(v, "claude-code")).toBe(
      "claude-code: harness API error (harness tag: server_error; API Error: 500)",
    );
  });

  test("flattens newlines and tabs to one line", () => {
    expect(oneLineCapped("  a\nb\r\nc\td  ", 100)).toBe("a b  c d");
  });

  test("caps in UTF-8 BYTES on a code-point boundary, as the Go side does", () => {
    // 239 ASCII bytes + a 3-byte "€" straddles the 240-byte cap: the "€" must be
    // dropped whole, never split.
    const s = "x".repeat(239) + "€tail";
    const out = oneLineCapped(s, apiErrorDetailCap);
    expect(out).toBe("x".repeat(239) + "…");
    expect(oneLineCapped("short", apiErrorDetailCap)).toBe("short");
  });
});

describe("the event stream is unchanged for a transcript with no failure", () => {
  test("an untagged event serializes with no api_error key", () => {
    const evs = events(jsonl(U("q"), A("answer")));
    for (const e of evs) {
      expect(e.apiError).toBeUndefined();
      expect(Object.keys(toPublicJSON(e))).not.toContain("api_error");
    }
  });

  test("a tagged event carries api_error on the public form", () => {
    const [e] = events(jsonl(TAGGED("overloaded")));
    expect(toPublicJSON(e).api_error).toBe("overloaded");
  });
});
