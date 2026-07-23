// Port of pkg/turns/harness/codex/sessionid_test.go.

import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newScreen } from "../../../src/screen/index.ts";
import * as codex from "../../../src/turns/harness/codex.ts";
import { corpusBytes } from "../corpus.ts";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

describe("codex session id", () => {
  test("scrapes legacy resume hint", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1";
    const scr = newScreen(120, 40);
    await scr.write(
      "\x1b[H\x1b[2JTo continue this session, run codex resume " +
        uuid +
        "\r\n",
    );
    const [id, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(true);
    expect(id).toBe(uuid);
  });

  test("gap on 0.142 screen (no resume hint)", async () => {
    const post0142 =
      "26. line twenty-six\r\n" +
      "… (earlier lines scrolled off) …\r\n" +
      "› Summarize recent commits\r\n" +
      "gpt-5.5 default · 1.2M tokens left\r\n";
    const scr = newScreen(120, 40);
    await scr.write("\x1b[H\x1b[2J" + post0142);
    const [, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(false);
  });

  test("scrapes the /status box Session row", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1";
    const scr = newScreen(120, 40);
    const box =
      "\x1b[H\x1b[2J" +
      "╭──────────────────────────────────────────────────────────╮\r\n" +
      "│ >_ OpenAI Codex (v0.142.5)                                 │\r\n" +
      "│ Session:  " +
      uuid +
      "               │\r\n" +
      "│ Model:    gpt-5.5                                          │\r\n" +
      "╰──────────────────────────────────────────────────────────╯\r\n" +
      "› \r\n";
    await scr.write(box);
    const [id, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(true);
    expect(id).toBe(uuid);
  });

  test("scrapes the /quit resume hint", async () => {
    const uuid = "019f0287-aaaa-7013-a43a-4eb1f65d94f1";
    const scr = newScreen(120, 40);
    await scr.write(
      "\x1b[H\x1b[2JTo continue this session, run codex resume " +
        uuid +
        "\r\n",
    );
    const [id, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(true);
    expect(id).toBe(uuid);
  });

  test("does not mis-capture a Session:-shaped string in reply prose", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1";
    const scr = newScreen(120, 40);
    // No box borders, no /status header — an assistant reply that merely mentions
    // a Session: <uuid> string must not be captured.
    await scr.write(
      "\x1b[H\x1b[2JThe log line reads: Session: " +
        uuid +
        " started.\r\n› \r\n",
    );
    const [, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(false);
  });

  test("does not capture a wrapped /status box (narrow terminal)", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1";
    const scr = newScreen(30, 40);
    // The UUID wraps onto a second physical row, so the border-anchored row regex
    // cannot match — no false capture; the width dependency is documented here.
    await scr.write(
      "\x1b[H\x1b[2J" +
        "│ >_ OpenAI Codex (v0.142.5) │\r\n" +
        "│ Session:  " +
        uuid.slice(0, 12) +
        "\r\n" +
        uuid.slice(12) +
        " │\r\n",
    );
    const [, ok] = codex.New().extractSessionID(scr.snapshot());
    expect(ok).toBe(false);
  });

  test("readTranscript projects the on-disk log to turns", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    tmpRoots.push(root);
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1";

    const dir = join(root, "2026", "06", "26");
    mkdirSync(dir, { recursive: true });
    const body =
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}\n` +
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}\n`;
    writeFileSync(join(dir, `rollout-2026-06-26T07-25-23-${uuid}.jsonl`), body);

    const a = codex.New();
    a.sessionsRoot = root; // test seam: override default ~/.codex/sessions
    const turns = a.readTranscript(uuid, "/unused");
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toBe("hello");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("hi there");
  });

  test("readTranscript throws for a missing session", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    tmpRoots.push(root);
    const a = codex.New();
    a.sessionsRoot = root;
    expect(() => a.readTranscript("no-such-uuid", "/unused")).toThrow();
  });

  test("resumeArgs leads with the `resume <uuid>` subcommand", () => {
    const args = codex.New().resumeArgs("sess-uuid");
    expect(args).toEqual(["resume", "sess-uuid"]);
  });
});

// Until META-HARNESS-110 recorded these, every /status test above was synthetic
// and statusSessionRE had NO recorded-corpus coverage — a real layout change to
// the box would not have failed a single test. These replay live codex-cli
// 0.144.5 recordings, so they are the fixtures that would catch one.
describe("codex session id: recorded /status corpus", () => {
  const scenarios = [
    "status-default", // Default collaboration
    "status-plan", // Plan collaboration
    "status-manual",
    "status-auto",
    "status-bypass",
    "status-readonly-default",
    "status-readonly-never",
    "status-readonly-onrequest",
  ];

  async function replay(scenario: string) {
    const bytes = corpusBytes("codex", scenario);
    expect(bytes, scenario).not.toBeNull();
    const scr = newScreen(120, 40);
    await scr.write(bytes!);
    return scr.snapshot();
  }

  for (const scenario of scenarios) {
    test(`${scenario}: scrapes the Session row through statusBoxHeaderRE`, async () => {
      const snap = await replay(scenario);
      // The recordings never show the `codex resume <uuid>` hint (no /quit), so
      // the capture below can only have come through the /status branch — the
      // one statusBoxHeaderRE now gates.
      expect(snap.text).not.toMatch(/codex resume /);
      const [id, ok] = codex.New().extractSessionID(snap);
      expect(ok).toBe(true);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // The captured id is the one painted in the box, not one scraped elsewhere.
      expect(snap.text).toContain("Session:");
      expect(snap.text).toContain(id);
    });
  }

  test("the recordings carry distinct session ids — no cross-fixture contamination", async () => {
    const ids: string[] = [];
    for (const scenario of scenarios) {
      const [id] = codex.New().extractSessionID(await replay(scenario));
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(scenarios.length);
  });

  test("stripping the codex banner closes the gate — the box rows alone do not capture", async () => {
    // statusBoxHeaderRE gates HARNESS IDENTITY: `>_ OpenAI Codex (v` is the
    // startup banner, not a box-only string. With it removed the `│ Session: … │`
    // rows are still on screen, and the scrape must still decline.
    const snap = await replay("status-default");
    const text = snap.text.replaceAll(
      ">_ OpenAI Codex (v",
      ">_ Some Other CLI(",
    );
    expect(text).toMatch(/│[^\r\n]*Session:[^\r\n]*│/);
    const [, ok] = codex.New().extractSessionID({ ...snap, text });
    expect(ok).toBe(false);
  });
});
