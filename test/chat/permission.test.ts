// Deterministic tests for the pure permission-mode parser: synthetic footer /
// `/status` fixtures, a replay of the recorded claude `auto` corpus, and a
// replay of the eight recorded codex `/status` boxes (test/corpus/codex/
// status-*, live codex-cli 0.144.5) that freeze the Permissions: mapping table.
// No live CLI, no PTY, no Conversation.

import { describe, expect, test } from "vitest";

import {
  parsePermissionMode,
  normalizePermissionRung,
} from "../../src/chat/permission.ts";
import { newScreen } from "../../src/screen/index.ts";
import { corpusBytes } from "../turns/corpus.ts";

/** The five real footers, captured live from claude 2.1.217. */
const footers = {
  auto: "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  manual: "⏸ manual mode on · ← for agents",
  acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  plan: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
  bypass: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
} as const;

/** A plausible composer screen with `footer` painted at the bottom. */
function screenWith(footer: string): string {
  return [
    "● Sure, here you go.",
    "",
    "❯ ",
    "─────────────────────────────────",
    "  " + footer,
    "",
  ].join("\n");
}

describe("parsePermissionMode: claude-code footers", () => {
  test("manual mode is detected — it is the ONLY footer without the (shift+tab to cycle) suffix, and claude's default", () => {
    const r = parsePermissionMode(screenWith(footers.manual), "claude-code")!;
    expect(r.observed).toBe("manual");
    expect(r.source).toBe("footer");
    expect(r.raw).toBe("manual mode on");
  });

  test("all five real footers parse to their rungs", () => {
    for (const [rung, footer] of Object.entries(footers)) {
      const r = parsePermissionMode(screenWith(footer), "claude-code")!;
      expect(r.observed, footer).toBe(rung);
      expect(r.source, footer).toBe("footer");
    }
  });

  test("the glyph gate accepts ⏵⏵ / ⏸, one or two repeats, with or without U+FE0F", () => {
    const glyphs = ["⏵", "⏵⏵", "⏸", "⏸⏸", "⏵️", "⏵️⏵️", "⏸️"];
    for (const g of glyphs) {
      const r = parsePermissionMode(
        screenWith(`${g} plan mode on (shift+tab to cycle)`),
        "claude-code",
      )!;
      expect(r.observed, g).toBe("plan");
      expect(r.source, g).toBe("footer");
    }
  });

  test("a renamed/hyphenated mode degrades to unknown + raw, still source: footer", () => {
    const r = parsePermissionMode(
      screenWith("⏵⏵ read-only mode on (shift+tab to cycle)"),
      "claude-code",
    )!;
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("read-only mode on");
    expect(r.source).toBe("footer");
  });

  test("the flag-only dontAsk spelling falls into the off-ladder row, not a rung", () => {
    const r = parsePermissionMode(
      screenWith("⏵⏵ dontAsk mode on (shift+tab to cycle)"),
      "claude-code",
    )!;
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("dontAsk mode on");
    expect(r.source).toBe("footer");
  });

  test("a glyph line with no ' on' shape reports unparsed_footer with the trimmed line", () => {
    const r = parsePermissionMode(
      screenWith("⏵⏵ some entirely different footer · ← for agents"),
      "claude-code",
    )!;
    expect(r.source).toBe("unparsed_footer");
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("⏵⏵ some entirely different footer · ← for agents");
  });

  test("no footer at all reports no_footer with no raw — structurally distinct from unparsed_footer", () => {
    const blockingDialog = [
      "Do you trust the files in this folder?",
      "",
      "❯ 1. Yes, proceed",
      "  2. No, exit",
    ].join("\n");
    const r = parsePermissionMode(blockingDialog, "claude-code")!;
    expect(r.observed).toBe("unknown");
    expect(r.source).toBe("no_footer");
    expect(r.raw).toBeUndefined();
  });

  test("spoof: a reply quoting a footer above the real one reports the REAL (bottom-most) mode", () => {
    const text = [
      "● Earlier I saw:",
      "",
      "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
      "",
      "❯ ",
      "─────────────────────────────────",
      "  ⏸ manual mode on · ← for agents",
    ].join("\n");
    const r = parsePermissionMode(text, "claude-code")!;
    expect(r.observed).toBe("manual");
  });

  test("bare prose without the glyph never matches", () => {
    const text = ["● The docs say plan mode on is the safe default.", ""].join(
      "\n",
    );
    const r = parsePermissionMode(text, "claude-code")!;
    expect(r.observed).toBe("unknown");
    expect(r.source).toBe("no_footer");
  });

  test("lastIndex regression: two consecutive calls on the same text agree", () => {
    const text = screenWith(footers.bypass);
    const a = parsePermissionMode(text, "claude-code")!;
    const b = parsePermissionMode(text, "claude-code")!;
    expect(b).toEqual(a);
    expect(a.observed).toBe("bypass");

    // Same for the glyph-only probe's path.
    const g = screenWith("⏵⏵ nothing parseable here");
    const c = parsePermissionMode(g, "claude-code")!;
    const d = parsePermissionMode(g, "claude-code")!;
    expect(d).toEqual(c);
    expect(c.source).toBe("unparsed_footer");
  });
});

describe("parsePermissionMode: claude-code corpus replay", () => {
  // Live 2.1.201 recordings, all painting "⏵⏵ auto mode on (shift+tab to cycle)".
  for (const scenario of ["interrupted-mid-reply", "multi-turn", "tool-call"]) {
    test(`${scenario} reports auto from the recorded footer`, async () => {
      const bytes = corpusBytes("claude-code", scenario);
      expect(bytes).not.toBeNull();
      const scr = newScreen(120, 40);
      await scr.write(bytes!);
      const r = parsePermissionMode(scr.snapshot().text, "claude-code")!;
      expect(r.observed).toBe("auto");
      expect(r.source).toBe("footer");
      expect(r.raw).toBe("auto mode on");
    });
  }
});

/** Builds a synthetic codex `/status` box with the given rows. */
function statusBox(rows: string[], width = 58): string {
  const inner = width - 2;
  const border = (l: string, r: string) => l + "─".repeat(inner) + r;
  const pad = (s: string) => "│" + s.padEnd(inner, " ").slice(0, inner) + "│";
  return [
    ">_ OpenAI Codex (v0.144.5)",
    "",
    border("╭", "╮"),
    ...rows.map(pad),
    border("╰", "╯"),
    "",
    "› ",
  ].join("\n");
}

describe("parsePermissionMode: codex /status", () => {
  test("reads the permissions rung and the collaboration axis from the positive rows", () => {
    const text = statusBox([
      "  Permissions:          Workspace (Ask for approval)",
      "  Collaboration mode:   Default",
    ]);
    const r = parsePermissionMode(text, "codex")!;
    expect(r.observed).toBe("acceptEdits");
    expect(r.raw).toBe("Workspace (Ask for approval)");
    expect(r.collaboration).toBe("default");
    expect(r.source).toBe("status");
  });

  test("each mapped Permissions: value yields its rung", () => {
    // The frozen table — every entry observed live on codex-cli 0.144.5 and
    // carried by a test/corpus/codex/status-* fixture (replayed below).
    const cases: [string, string][] = [
      ["Workspace (Ask for approval)", "acceptEdits"],
      ["Full Access", "bypass"],
      ["Custom (workspace, untrusted)", "manual"],
      ["Custom (workspace, never)", "auto"],
      ["Read Only (untrusted)", "plan"],
      ["Read Only (never)", "plan"],
      ["Read Only (Ask for approval)", "plan"],
    ];
    for (const [value, rung] of cases) {
      const r = parsePermissionMode(
        statusBox(["  Permissions:   " + value], 64),
        "codex",
      )!;
      expect(r.observed, value).toBe(rung);
      expect(r.raw, value).toBe(value);
    }
  });

  test("Workspace (Approve for me) is NOT coerced onto a rung — it has no CLI spelling", () => {
    const r = parsePermissionMode(
      statusBox(["  Permissions:   Workspace (Approve for me)"], 64),
      "codex",
    )!;
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("Workspace (Approve for me)");
    expect(r.source).toBe("status");
  });

  test("an unrecognized Custom (<sandbox>, <policy>) pair is unknown + raw", () => {
    // `Custom (read-only, …)` is the shape the table PREDICTED before the live
    // probe; 0.144.5 renders `Read Only (…)` instead. The table is an exhaustive
    // lookup of observed strings, so the never-observed shape must fall through
    // rather than be reconstructed from the sandbox/policy pair.
    for (const value of [
      "Custom (read-only, never)",
      "Custom (read-only, untrusted)",
      "Custom (workspace, on-request)",
    ]) {
      const r = parsePermissionMode(
        statusBox(["  Permissions:   " + value], 64),
        "codex",
      )!;
      expect(r.observed, value).toBe("unknown");
      expect(r.raw, value).toBe(value);
    }
  });

  test("absence of the Collaboration mode row is NOT a signal — collaboration stays unknown", () => {
    const r = parsePermissionMode(
      statusBox(["  Permissions:   Full Access"], 64),
      "codex",
    )!;
    expect(r.observed).toBe("bypass");
    expect(r.collaboration).toBe("unknown");
  });

  test("the codex banner gates the parse — box rows without it read as unknown", () => {
    const text = [
      "│  Permissions:          Full Access                    │",
      "│  Collaboration mode:   Default                        │",
    ].join("\n");
    const r = parsePermissionMode(text, "codex")!;
    expect(r.observed).toBe("unknown");
    expect(r.collaboration).toBe("unknown");
    expect(r.raw).toBeUndefined();
  });

  test("a wrapped Permissions: row fails closed — never a truncated-but-parsed wrong mode", async () => {
    // The row is wider than the screen, so the closing │ is pushed to the next
    // physical line and the same-line anchor rejects it.
    const wide = statusBox(
      ["  Permissions:          Custom (workspace, untrusted)"],
      90,
    );
    const scr = newScreen(60, 20);
    await scr.write(new TextEncoder().encode(wide.replace(/\n/g, "\r\n")));
    const r = parsePermissionMode(scr.snapshot().text, "codex")!;
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBeUndefined();
  });

  test("cols === 60 exactly: an unwrapped row still parses through a real Screen", async () => {
    // At exactly CODEX_STATUS_MIN_COLS the primer's /status write is NOT
    // skipped, so the closing-│ anchor is the only guard at this width.
    const text = statusBox([
      "  Permissions:          Custom (workspace, untrusted)",
    ]);
    const scr = newScreen(60, 20);
    await scr.write(new TextEncoder().encode(text.replace(/\n/g, "\r\n")));
    const r = parsePermissionMode(scr.snapshot().text, "codex")!;
    expect(r.observed).toBe("manual");
    expect(r.raw).toBe("Custom (workspace, untrusted)");
  });
});

describe("parsePermissionMode: codex /status corpus replay", () => {
  /** Replays a recorded `/status` box through a real Screen, as the parser sees it. */
  async function statusReading(scenario: string) {
    const bytes = corpusBytes("codex", scenario);
    expect(bytes, scenario).not.toBeNull();
    const scr = newScreen(120, 40);
    await scr.write(bytes!);
    return {
      text: scr.snapshot().text,
      reading: parsePermissionMode(scr.snapshot().text, "codex")!,
    };
  }

  // The frozen table, one recorded fixture per row. Each was captured live from
  // codex-cli 0.144.5 with the launch flags named in its meta.json.
  const fixtures: {
    scenario: string;
    raw: string;
    observed: string;
    collaboration: string;
  }[] = [
    {
      scenario: "status-default",
      raw: "Workspace (Ask for approval)",
      observed: "acceptEdits",
      collaboration: "default",
    },
    {
      scenario: "status-manual",
      raw: "Custom (workspace, untrusted)",
      observed: "manual",
      collaboration: "default",
    },
    {
      scenario: "status-auto",
      raw: "Custom (workspace, never)",
      observed: "auto",
      collaboration: "default",
    },
    {
      scenario: "status-bypass",
      raw: "Full Access",
      observed: "bypass",
      collaboration: "default",
    },
    {
      scenario: "status-readonly-default",
      raw: "Read Only (untrusted)",
      observed: "plan",
      collaboration: "default",
    },
    {
      scenario: "status-readonly-never",
      raw: "Read Only (never)",
      observed: "plan",
      collaboration: "default",
    },
    {
      scenario: "status-readonly-onrequest",
      raw: "Read Only (Ask for approval)",
      observed: "plan",
      collaboration: "default",
    },
    {
      scenario: "status-plan",
      raw: "Read Only (untrusted)",
      observed: "plan",
      collaboration: "plan",
    },
  ];

  for (const f of fixtures) {
    test(`${f.scenario} reads ${f.observed} / ${f.collaboration} from the recorded box`, async () => {
      const { reading } = await statusReading(f.scenario);
      expect(reading.raw).toBe(f.raw);
      expect(reading.observed).toBe(f.observed);
      expect(reading.collaboration).toBe(f.collaboration);
      expect(reading.source).toBe("status");
    });
  }

  test("Default collaboration is read from the POSITIVE row, not inferred from absence", async () => {
    const { text, reading } = await statusReading("status-default");
    // The row is really painted — "default" here is a reading, not a fallback.
    expect(text).toMatch(
      /│[^\r\n]*Collaboration mode:[^\r\n]*Default[^\r\n]*│/,
    );
    expect(reading.collaboration).toBe("default");
    expect(reading.collaboration).not.toBe("unknown");
  });

  test("Plan collaboration is read from the positive row", async () => {
    const { text, reading } = await statusReading("status-plan");
    expect(text).toMatch(/│[^\r\n]*Collaboration mode:[^\r\n]*Plan[^\r\n]*│/);
    expect(reading.collaboration).toBe("plan");
  });

  test("the two axes do NOT collapse: same launch flags, /plan is the only difference", async () => {
    // status-readonly-default and status-plan were both launched
    // `-s read-only -a untrusted`; only status-plan then ran `/plan`. A codex
    // session is honestly "plan" only when BOTH axes say so.
    const noPlan = (await statusReading("status-readonly-default")).reading;
    const withPlan = (await statusReading("status-plan")).reading;

    expect(noPlan.observed).toBe("plan");
    expect(withPlan.observed).toBe("plan");
    expect(noPlan.raw).toBe(withPlan.raw); // identical permissions axis

    expect(noPlan.collaboration).toBe("default");
    expect(withPlan.collaboration).toBe("plan");

    const honestlyPlan = (r: typeof noPlan) =>
      r.observed === "plan" && r.collaboration === "plan";
    expect(honestlyPlan(noPlan)).toBe(false);
    expect(honestlyPlan(withPlan)).toBe(true);
  });

  test("auto is no longer provisional — the recorded box round-trips requested === observed", async () => {
    // The META-HARNESS-110 acceptance gate: `-s workspace-write -a never` must
    // not report permanent unresolvable drift on a rung the ladder can express.
    const { reading } = await statusReading("status-auto");
    expect(normalizePermissionRung("never", "codex")).toBe("auto");
    expect(reading.observed).toBe("auto");
    expect(normalizePermissionRung("never", "codex")).toBe(reading.observed);
  });

  test("every recorded box also exposes the Session: row the id scrape depends on", async () => {
    // First recorded-corpus coverage for statusSessionRE
    // (src/turns/harness/codex.ts) — until these fixtures landed it had none.
    const sessionRowRE =
      /│[^\S\r\n]*Session:[^\S\r\n]+[0-9a-fA-F-]{36}[^\S\r\n]*│/;
    for (const f of fixtures) {
      const { text } = await statusReading(f.scenario);
      expect(text, f.scenario).toContain(">_ OpenAI Codex (v");
      expect(sessionRowRE.test(text), f.scenario).toBe(true);
    }
  });
});

describe("parsePermissionMode: unsupported harnesses", () => {
  test("returns null so the caller can mint the launch reading", () => {
    for (const harness of ["pi", "opencode", "generic", ""]) {
      expect(
        parsePermissionMode(screenWith(footers.auto), harness),
        harness,
      ).toBeNull();
    }
  });
});

describe("normalizePermissionRung", () => {
  test("claude native spellings map onto the ladder", () => {
    expect(normalizePermissionRung("bypassPermissions", "claude-code")).toBe(
      "bypass",
    );
    expect(normalizePermissionRung("acceptEdits", "claude-code")).toBe(
      "acceptEdits",
    );
    expect(normalizePermissionRung("plan", "claude-code")).toBe("plan");
    expect(normalizePermissionRung("default", "claude-code")).toBe("manual");
  });

  test("codex -s / -a spellings map onto the ladder", () => {
    expect(normalizePermissionRung("read-only", "codex")).toBe("plan");
    expect(normalizePermissionRung("untrusted", "codex")).toBe("manual");
    expect(normalizePermissionRung("on-request", "codex")).toBe("acceptEdits");
    expect(normalizePermissionRung("never", "codex")).toBe("auto");
    expect(normalizePermissionRung("danger-full-access", "codex")).toBe(
      "bypass",
    );
  });

  test("the five rung names are identities for every harness", () => {
    const rungs = ["plan", "manual", "acceptEdits", "auto", "bypass"] as const;
    for (const harness of ["claude-code", "codex", "pi", "generic", ""]) {
      for (const rung of rungs) {
        expect(
          normalizePermissionRung(rung, harness),
          `${harness}/${rung}`,
        ).toBe(rung);
      }
    }
  });

  test("off-ladder values are undefined, not coerced", () => {
    expect(normalizePermissionRung("dontAsk", "claude-code")).toBeUndefined();
    expect(normalizePermissionRung("granular", "codex")).toBeUndefined();
    expect(normalizePermissionRung("", "claude-code")).toBeUndefined();
    // claude's spelling is not a codex spelling.
    expect(
      normalizePermissionRung("bypassPermissions", "codex"),
    ).toBeUndefined();
  });
});
