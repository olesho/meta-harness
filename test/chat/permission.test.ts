// Deterministic tests for the pure permission-mode parser: synthetic footer /
// `/status` fixtures plus a replay of the recorded claude `auto` corpus. No live
// CLI, no PTY, no Conversation.

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

/** Replays a recorded corpus stream into a 120x40 Screen and parses it. */
async function replay(scenario: string) {
  const bytes = corpusBytes("claude-code", scenario);
  expect(bytes).not.toBeNull();
  const scr = newScreen(120, 40);
  await scr.write(bytes!);
  return parsePermissionMode(scr.snapshot().text, "claude-code")!;
}

describe("parsePermissionMode: claude-code corpus replay", () => {
  // Live 2.1.201 recordings, all painting "⏵⏵ auto mode on (shift+tab to cycle)"
  // at expected.txt:40. interrupted-mid-reply doubles as proof that the footer
  // survives an interrupted turn.
  for (const scenario of ["interrupted-mid-reply", "multi-turn", "tool-call"]) {
    test(`${scenario} reports auto from the recorded footer`, async () => {
      const r = await replay(scenario);
      expect(r.observed).toBe("auto");
      expect(r.source).toBe("footer");
      expect(r.raw).toBe("auto mode on");
    });
  }

  // The four rungs the `auto` recordings cannot cover, hand-recorded against
  // live claude 2.1.218 by cycling shift+tab (bypass is off the cycle, so it is
  // launched with --permission-mode bypassPermissions). See each fixture's
  // meta.json for the keystrokes and the glyph-run codepoints.
  //
  // THE load-bearing case: `manual` is the ONLY footer without the
  // "(shift+tab to cycle)" suffix, and it is claude's current DEFAULT — a regex
  // that required that suffix would silently fail to see the most common mode.
  test("manual: the suffix-less footer still parses (regression)", async () => {
    const r = await replay("permission-mode-manual");
    expect(r.observed).toBe("manual");
    expect(r.source).toBe("footer");
    expect(r.raw).toBe("manual mode on");
    // Recorded as "⏸ manual mode on" — no "(shift+tab to cycle)" tail at all.
    expect(r.raw).not.toContain("shift+tab");
  });

  const rungs: [string, string, string][] = [
    ["permission-mode-accept-edits", "acceptEdits", "accept edits on"],
    ["permission-mode-plan", "plan", "plan mode on"],
    ["permission-mode-bypass", "bypass", "bypass permissions on"],
  ];
  for (const [scenario, observed, raw] of rungs) {
    test(`${scenario} reports ${observed} from the recorded footer`, async () => {
      const r = await replay(scenario);
      expect(r.observed).toBe(observed);
      expect(r.source).toBe("footer");
      expect(r.raw).toBe(raw);
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
    const cases: [string, string][] = [
      ["Workspace (Ask for approval)", "acceptEdits"],
      ["Full Access", "bypass"],
      ["Custom (workspace, untrusted)", "manual"],
      ["Custom (read-only, untrusted)", "plan"],
      ["Custom (workspace, never)", "auto"],
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
    const r = parsePermissionMode(
      statusBox(["  Permissions:   Custom (read-only, never)"], 64),
      "codex",
    )!;
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("Custom (read-only, never)");
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
