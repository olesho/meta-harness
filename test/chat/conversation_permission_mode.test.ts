// Conversation.permissionMode() — the live read — plus the prime-loop surgery
// that makes the codex `/status` box observable at all (META-HARNESS-111).
//
// These drive Conversation.primeSessionID directly (a private method reached via
// a bracket escape, the shape codex_prime_sessionid.test.ts established) with an
// injected writeStdin that simulates how Codex renders in response to the
// primer's keystrokes — no disk, no PTY, no child process.
import { describe, expect, test } from "vitest";
import { Conversation } from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { newScreen, type Screen } from "../../src/screen/index.ts";
import { claudecode, codex } from "../../src/turns/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import { ErrInputPending } from "../../src/chat/errors.ts";
import { type Session } from "../../src/chat/types.ts";

const READY = "Codex\r\n\r\n› \r\n";

/** The `/quit` hint frame: it yields the session id and carries NO /status box. */
function resumeHint(uuid: string): string {
  return (
    "\x1b[H\x1b[2J" +
    "To continue this session, run codex resume " +
    uuid +
    "\r\n" +
    "› \r\n"
  );
}

/**
 * A wide `/status` box. `rows` are the box's inner rows; pass a Session: row to
 * make it yield the id, a Permissions: row to make it yield the mode, or both.
 */
function statusBox(rows: string[], width = 62): string {
  const inner = width - 2;
  const border = (l: string, r: string) => l + "─".repeat(inner) + r;
  const pad = (s: string) => "│" + s.padEnd(inner, " ").slice(0, inner) + "│";
  return (
    "\x1b[H\x1b[2J" +
    [
      ">_ OpenAI Codex (v0.144.5)",
      "",
      border("╭", "╮"),
      ...rows.map(pad),
      border("╰", "╯"),
      "",
      "› ",
      "",
    ].join("\r\n")
  );
}

const idRow = (uuid: string) => "  Session:              " + uuid;
const permRow = (v = "Workspace (Ask for approval)") =>
  "  Permissions:          " + v;
const collabRow = (v = "Default") => "  Collaboration mode:   " + v;

interface Built {
  c: Conversation;
  scr: Screen;
  store: ReturnType<typeof newMemStore>;
  sess: Session;
  sent: string[];
}

let seq = 0;

async function build(opts: {
  cols?: number;
  primeBound?: number;
  permissionMode?: string;
  harnessSessionID?: string;
  onStatus?: (scr: Screen, count: number, sent: string[]) => void;
}): Promise<Built> {
  const scr = newScreen(opts.cols ?? 120, 40);
  const store = newMemStore();
  const sess: Session = {
    id: "permmode-" + ++seq,
    harness: "codex",
    workingDir: "/work",
    createdAt: new Date(),
    harnessSessionID: opts.harnessSessionID ?? "",
  };
  const sent: string[] = [];
  const c = new Conversation({
    opts: {
      harness: "codex",
      cols: opts.cols ?? 120,
      rows: 40,
      primeBound: opts.primeBound ?? 300,
      permissionMode: opts.permissionMode,
    },
    adapter: codex.New(),
    screen: scr,
    store,
    session: { ...sess },
    writeStdin: (p) => {
      const s = new TextDecoder().decode(p);
      sent.push(s);
      if (s.includes("/status") && opts.onStatus) {
        const count = sent.filter((x) => x.includes("/status")).length;
        opts.onStatus(scr, count, sent);
      }
    },
  });
  await store.createSession({ ...sess });
  return { c, scr, store, sess, sent };
}

function statusCount(sent: string[]): number {
  return sent.filter((s) => s.includes("/status")).length;
}

function primeOutcomeOf(c: Conversation): string | undefined {
  return (c as unknown as { primeOutcome?: string }).primeOutcome;
}

/** A claude-code conversation with `text` painted on its screen. */
async function claudeConv(
  text: string,
  permissionMode?: string,
): Promise<Conversation> {
  const scr = newScreen(120, 40);
  await scr.write(text.replace(/\n/g, "\r\n"));
  return new Conversation({
    opts: { harness: "claude-code", cols: 120, rows: 40, permissionMode },
    adapter: claudecode.New(),
    screen: scr,
    store: newMemStore(),
    session: {
      id: "claude-permmode",
      harness: "claude-code",
      workingDir: "/work",
      createdAt: new Date(),
      harnessSessionID: "",
    },
  });
}

const AUTO_FOOTER = [
  "● Sure, here you go.",
  "",
  "❯ ",
  "──────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "",
].join("\n");

// ── The codex box, captured at prime time ────────────────────────────────────

describe("codex: the /status box is captured at prime time", () => {
  test("id and box in one frame: source status, one /status write, loop exits at once", async () => {
    const uuid = "019f1000-0000-7013-a43a-000000000001";
    const { c, scr, sent } = await build({
      primeBound: 2000, // wide: a prompt exit means the loop really did return early
      onStatus: (s) =>
        void s.write(statusBox([idRow(uuid), permRow(), collabRow()])),
    });
    await scr.write(READY);
    const t0 = performance.now();
    await c["primeSessionID"](Context.background());
    expect(performance.now() - t0).toBeLessThan(1000);

    expect(c.session.harnessSessionID).toBe(uuid);
    expect(primeOutcomeOf(c)).toBe("captured");
    expect(statusCount(sent)).toBe(1); // exactly one — no resend needed

    const r = c.permissionMode();
    expect(r.observed).toBe("acceptEdits");
    expect(r.raw).toBe("Workspace (Ask for approval)");
    expect(r.collaboration).toBe("default");
    expect(r.source).toBe("status");
  });

  test("the cached reading survives the box scrolling off (Snapshot is viewport-only)", async () => {
    const uuid = "019f1000-0000-7013-a43a-000000000002";
    const { c, scr } = await build({
      onStatus: (s) => void s.write(statusBox([idRow(uuid), permRow()])),
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    const primed = c.permissionMode();
    expect(primed.observed).toBe("acceptEdits");

    // A turn repaints the screen; the box is gone from the viewport.
    await scr.write("\x1b[H\x1b[2J● a reply\r\n› \r\n");
    expect(c.screenSnapshot().text).not.toContain("Permissions:");

    const later = c.permissionMode();
    expect(later.observed).toBe("acceptEdits");
    expect(later.source).toBe("status");
    // Frozen at the frame it was READ from — staleness is the caller's to weigh.
    expect(later.generation).toBe(primed.generation);
    expect(later.generation).toBeLessThan(c.screenSnapshot().generation);
  });

  test("an off-ladder Permissions: value still counts as an observation", async () => {
    const uuid = "019f1000-0000-7013-a43a-000000000003";
    const { c, scr } = await build({
      onStatus: (s) =>
        void s.write(
          statusBox([idRow(uuid), permRow("Workspace (Approve for me)")]),
        ),
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    const r = c.permissionMode();
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBe("Workspace (Approve for me)");
    expect(r.source).toBe("status");
  });
});

// ── The decoupling: an early id must not cancel the box capture ──────────────

describe("codex: the box capture is decoupled from the id capture", () => {
  test("id from the `codex resume` hint (no box), box on a LATER frame within the bound", async () => {
    const uuid = "019f2000-0000-7013-a43a-000000000001";
    const { c, scr, sent } = await build({
      primeBound: 3000,
      // The first frame after the write is the resume hint — it yields the id
      // and carries no box. The box lands a beat later.
      onStatus: (s, count) => {
        if (count > 1) return;
        void (async () => {
          await s.write(resumeHint(uuid));
          await s.write(statusBox([permRow("Full Access"), collabRow("Plan")]));
        })();
      },
    });
    await scr.write(READY);
    const t0 = performance.now();
    await c["primeSessionID"](Context.background());
    const elapsed = performance.now() - t0;

    expect(c.session.harnessSessionID).toBe(uuid);
    expect(primeOutcomeOf(c)).toBe("captured");
    const r = c.permissionMode();
    expect(r.observed).toBe("bypass");
    expect(r.collaboration).toBe("plan");
    expect(r.source).toBe("status");
    // The loop exited on the box, not on the deadline: no hang, and well inside
    // primeBoundDur().
    expect(elapsed).toBeLessThan(3000);
    expect(statusCount(sent)).toBe(1);
  });

  test("early id, box NEVER rendered: bounded by primeBoundDur, exactly two writes", async () => {
    const uuid = "019f2000-0000-7013-a43a-000000000002";
    const bound = 250;
    const { c, scr, sent } = await build({
      primeBound: bound,
      onStatus: (s, count) => {
        if (count === 1) void s.write(resumeHint(uuid));
      },
    });
    await scr.write(READY);
    const t0 = performance.now();
    await c["primeSessionID"](Context.background());
    const elapsed = performance.now() - t0;

    expect(c.session.harnessSessionID).toBe(uuid);
    // It waited for the box (the accepted ≤ primeBound startup cost) …
    expect(elapsed).toBeGreaterThanOrEqual(bound * 0.75);
    // … and it did NOT hang.
    expect(elapsed).toBeLessThan(bound * 8);
    // Initial write + the ONE-SHOT halfway resend. Never a third.
    expect(statusCount(sent)).toBe(2);
    expect(c.permissionMode().source).toBe("written_uncaptured");
  });

  test("primeOutcome stays `captured` through the tail classification (fallback disarmed)", async () => {
    const uuid = "019f2000-0000-7013-a43a-000000000003";
    const adapter = codex.New();
    let locates = 0;
    const realLocate = adapter.locateSessionID.bind(adapter);
    adapter.locateSessionID = (wd: string) => {
      locates++;
      return realLocate(wd);
    };
    const scr = newScreen(120, 40);
    const store = newMemStore();
    const sess: Session = {
      id: "permmode-fallback",
      harness: "codex",
      workingDir: "/work",
      createdAt: new Date(),
      harnessSessionID: "",
    };
    const c = new Conversation({
      opts: { harness: "codex", cols: 120, rows: 40, primeBound: 150 },
      adapter,
      screen: scr,
      store,
      session: { ...sess },
      writeStdin: (p) => {
        if (new TextDecoder().decode(p).includes("/status"))
          void scr.write(resumeHint(uuid));
      },
    });
    await store.createSession({ ...sess });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());

    // The tail classification ran (the loop sat to the deadline for the box) and
    // did NOT overwrite the capture.
    expect(primeOutcomeOf(c)).toBe("captured");
    // …so the guarded disk fallback is never armed on the TurnComplete path.
    await c.maybeExtractSessionID();
    expect(locates).toBe(0);
    expect(c.session.harnessSessionID).toBe(uuid);
  });

  test("ErrInputPending on the way out does not downgrade a `captured` outcome", async () => {
    const uuid = "019f2000-0000-7013-a43a-000000000004";
    const { c, scr } = await build({
      primeBound: 400,
      onStatus: (s, count) => {
        if (count === 1) void s.write(resumeHint(uuid));
      },
    });
    await scr.write(resumeHint(uuid)); // id is on screen before the write lands
    // Inject the throw at the box-capture seam, the only work the loop does
    // AFTER the id lands: it exercises the real catch block at the tail of
    // primeSessionID with primeOutcome already "captured".
    (
      c as unknown as { captureModeFromScreen: () => boolean }
    ).captureModeFromScreen = () => {
      throw ErrInputPending;
    };
    await c["primeSessionID"](Context.background());
    expect(c.session.harnessSessionID).toBe(uuid);
    expect(primeOutcomeOf(c)).toBe("captured");
  });

  test("setPrimeOutcome is write-once after `captured`", async () => {
    const { c } = await build({});
    const set = (c as unknown as { setPrimeOutcome: (o: string) => void })
      .setPrimeOutcome;
    set.call(c, "written_uncaptured");
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");
    set.call(c, "captured");
    for (const o of [
      "written_uncaptured",
      "persist_failed",
      "not_written",
      "too_narrow",
    ]) {
      set.call(c, o);
      expect(primeOutcomeOf(c)).toBe("captured");
    }
  });
});

// ── source derivation when the box was never observed ────────────────────────

describe("codex: source when the box was never observed", () => {
  test("prime never ran (resume / id already seeded) → not_primed", async () => {
    const uuid = "019f3000-0000-7013-a43a-000000000001";
    const { c, scr, sent } = await build({ harnessSessionID: uuid });
    await scr.write(READY);
    // Mirrors Reopen/resume: primeSessionID returns immediately on a seeded id,
    // so the box is NEVER rendered on this path.
    await c["primeSessionID"](Context.background());
    expect(sent.length).toBe(0);
    expect(primeOutcomeOf(c)).toBeUndefined();

    const r = c.permissionMode();
    expect(r.source).toBe("not_primed");
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBeUndefined();
  });

  test("a Conversation that never primed at all → not_primed", async () => {
    const { c } = await build({});
    expect(c.permissionMode().source).toBe("not_primed");
  });

  test("captured id, box never seen → written_uncaptured (the /status WAS written)", async () => {
    const uuid = "019f3000-0000-7013-a43a-000000000002";
    const { c, scr } = await build({
      primeBound: 150,
      onStatus: (s, count) => {
        if (count === 1) void s.write(resumeHint(uuid));
      },
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("captured");
    expect(c.permissionMode().source).toBe("written_uncaptured");
  });

  test("written but nothing rendered → written_uncaptured", async () => {
    const { c, scr } = await build({ primeBound: 120, onStatus: () => {} });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");
    expect(c.permissionMode().source).toBe("written_uncaptured");
  });

  test("prompt never ready → not_written", async () => {
    const { c, scr } = await build({ primeBound: 100 });
    await scr.write("Codex starting…\r\n");
    await c["primeSessionID"](Context.background());
    expect(c.permissionMode().source).toBe("not_written");
  });

  test("narrow terminal (cols < 60) → too_narrow, never a truncated-but-parsed mode", async () => {
    const { c, scr, sent } = await build({ cols: 40, primeBound: 100 });
    // Even with a (wrapped) box on screen, the prime is skipped entirely and
    // nothing is parsed.
    await scr.write(READY);
    await scr.write(statusBox([permRow("Full Access")], 40));
    await c["primeSessionID"](Context.background());
    expect(sent.length).toBe(0);
    const r = c.permissionMode();
    expect(r.source).toBe("too_narrow");
    expect(r.observed).toBe("unknown");
    expect(r.raw).toBeUndefined();
  });
});

// ── claude-code: a strict LIVE read, nothing cached ──────────────────────────

describe("claude-code: strict live footer read", () => {
  test("the footer parses off the current frame", async () => {
    const c = await claudeConv(AUTO_FOOTER);
    const r = c.permissionMode();
    expect(r.observed).toBe("auto");
    expect(r.source).toBe("footer");
    expect(r.raw).toBe("auto mode on");
    expect(r.generation).toBe(c.screenSnapshot().generation);
  });

  test("no footer this frame → no_footer, never a stale cached value", async () => {
    const c = await claudeConv(AUTO_FOOTER);
    expect(c.permissionMode().observed).toBe("auto");
    // A blocking trust dialog replaces the composer; the footer is gone.
    await c["screen"].write(
      "\x1b[H\x1b[2JDo you trust the files in this folder?\r\n\r\n❯ 1. Yes\r\n",
    );
    const r = c.permissionMode();
    expect(r.observed).toBe("unknown");
    expect(r.source).toBe("no_footer");
    expect(r.raw).toBeUndefined();
  });

  test("never reports not_primed — claude records no prime outcome", async () => {
    const c = await claudeConv("just some text\n❯ \n");
    expect(c.permissionMode().source).toBe("no_footer");
  });

  test("a passed snapshot is parsed instead of a fresh one (one frame for both)", async () => {
    const c = await claudeConv(AUTO_FOOTER);
    const snap = c.screenSnapshot();
    await c["screen"].write("\x1b[H\x1b[2Jnothing here\r\n");
    const r = c.permissionMode(snap);
    expect(r.observed).toBe("auto");
    expect(r.generation).toBe(snap.generation);
  });
});

// ── harnesses with no screen reader ──────────────────────────────────────────

describe("unsupported harnesses fall back to the launch reading", () => {
  for (const harness of ["pi", "opencode", "generic", ""]) {
    test(`${harness || "(empty)"} → observed unknown, source launch`, async () => {
      const scr = newScreen(120, 40);
      await scr.write("⏵⏵ auto mode on (shift+tab to cycle)\r\n› \r\n");
      const c = new Conversation({
        opts: { harness, cols: 120, rows: 40, permissionMode: "plan" },
        screen: scr,
        store: newMemStore(),
      });
      const r = c.permissionMode();
      expect(r.observed).toBe("unknown");
      expect(r.source).toBe("launch");
      expect(r.raw).toBeUndefined();
      // It does NOT fall through to a claude/codex parse of that footer…
      expect(r.requested).toBe("plan");
      expect(r.requestedRaw).toBe("plan");
    });
  }
});

// ── requested / requestedRaw ─────────────────────────────────────────────────

describe("requested is normalized on the way in", () => {
  test("claude's native bypassPermissions compares equal to observed bypass", async () => {
    const text = AUTO_FOOTER.replace("auto mode on", "bypass permissions on");
    const c = await claudeConv(text, "bypassPermissions");
    const r = c.permissionMode();
    expect(r.requested).toBe("bypass");
    expect(r.requestedRaw).toBe("bypassPermissions");
    expect(r.observed).toBe("bypass");
    expect(r.requested).toBe(r.observed); // no false drift alarm
  });

  test("the off-ladder dontAsk spelling yields undefined + the verbatim raw", async () => {
    const c = await claudeConv(AUTO_FOOTER, "dontAsk");
    const r = c.permissionMode();
    expect(r.requested).toBeUndefined();
    expect(r.requestedRaw).toBe("dontAsk");
    expect(r.observed).toBe("auto");
  });

  test("codex's native -s spelling normalizes too, on EVERY source", async () => {
    const { c } = await build({ permissionMode: "danger-full-access" });
    const r = c.permissionMode();
    expect(r.source).toBe("not_primed"); // independent of `requested`
    expect(r.requested).toBe("bypass");
    expect(r.requestedRaw).toBe("danger-full-access");
  });

  test("unset permissionMode leaves both fields undefined", async () => {
    const c = await claudeConv(AUTO_FOOTER);
    const r = c.permissionMode();
    expect(r.requested).toBeUndefined();
    expect(r.requestedRaw).toBeUndefined();
  });
});

// ── purity ───────────────────────────────────────────────────────────────────

describe("permissionMode() is a pure read", () => {
  test("zero PTY writes; primeOutcome and the store are unchanged", async () => {
    const uuid = "019f4000-0000-7013-a43a-000000000001";
    const { c, scr, store, sess, sent } = await build({
      onStatus: (s) => void s.write(statusBox([idRow(uuid), permRow()])),
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());

    const writesBefore = sent.length;
    const outcomeBefore = primeOutcomeOf(c);
    const storedBefore = { ...(await store.getSession(sess.id)) };

    for (let i = 0; i < 5; i++) c.permissionMode();

    expect(sent.length).toBe(writesBefore);
    expect(primeOutcomeOf(c)).toBe(outcomeBefore);
    expect(await store.getSession(sess.id)).toEqual(storedBefore);
  });

  test("it never re-probes an unobserved codex box", async () => {
    const { c, scr, sent } = await build({
      primeBound: 100,
      onStatus: () => {},
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    const before = statusCount(sent);
    expect(c.permissionMode().source).toBe("written_uncaptured");
    expect(c.permissionMode().source).toBe("written_uncaptured");
    expect(statusCount(sent)).toBe(before);
  });

  test("after close() it does not throw — it returns the last frame's parse", async () => {
    const c = await claudeConv(AUTO_FOOTER);
    const frozen = c.screenSnapshot().generation;
    await c.close();
    const r = c.permissionMode();
    expect(r.observed).toBe("auto");
    expect(r.source).toBe("footer");
    expect(r.generation).toBe(frozen);
  });

  test("after close() a codex conversation keeps its cached reading", async () => {
    const uuid = "019f4000-0000-7013-a43a-000000000002";
    const { c, scr } = await build({
      onStatus: (s) => void s.write(statusBox([idRow(uuid), permRow()])),
    });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    const before = c.permissionMode();
    await c.close();
    const after = c.permissionMode();
    expect(after.observed).toBe(before.observed);
    expect(after.generation).toBe(before.generation);
  });
});
