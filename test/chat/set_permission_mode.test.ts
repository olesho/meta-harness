// Conversation.setPermissionMode() — the write side of the permission story:
// gating, held()-not-acquire() locking, the per-press settle loop, lap detection
// and the claude Shift+Tab ring (META-HARNESS-117) — plus the codex
// collaboration 2-cycle and refreshPermissionMode (META-HARNESS-118).
//
// Named set_permission_mode rather than permission_mode because
// test/chat/permission_mode.test.ts is already taken by the LAUNCH-arg forward
// (the `--permission-mode` plumbing plus the bypass trust_prompt policy). This
// file is the mid-session switch; that one is the launch knob.
//
// Shape: test/chat/quit.test.ts — a Conversation built straight from
// newTestConv() with an injected KeyRecorder — plus a real Screen the test
// paints frames into. Painting frames directly is what makes the
// GENERATION-based stability predicate testable at all: the loop's correctness
// is defined in terms of how many distinct generations carried a value, which a
// pty-backed fake cannot pin. The end-to-end pty proof that the same bytes reach
// a real harness and parse back lives in test/chat/permission_cycle_fake.test.ts.
//
// EVERY "no bytes written" assertion below is the recorder's DELTA across the
// call, never a total: KeyRecorder is the conversation's whole writeStdin sink,
// so it also records the concurrent auto-dismiss pump. Totals flake; deltas do
// not.

import { describe, expect, test } from "vitest";

import { Conversation, EventBus } from "../../src/chat/conversation.ts";
import {
  ErrClosed,
  ErrInputPending,
  ErrNoControl,
  ErrPermissionModeStalled,
  ErrPermissionModeUnreachable,
  ErrPermissionModeUnsupported,
  ErrTurnInFlight,
  isSentinel,
} from "../../src/chat/errors.ts";
import type {
  PermissionModeReading,
  PermissionRung,
} from "../../src/chat/permission.ts";
import { RoleAssistant, TurnStatePending } from "../../src/chat/types.ts";
import { permissionModeResponse } from "../../src/gateway/dto.ts";
import { Context } from "../../src/internal/async/index.ts";
import { newScreen, type Screen } from "../../src/screen/index.ts";
import {
  claudecode,
  codex,
  generic,
  opencode,
  pi,
} from "../../src/turns/index.ts";
import {
  ClaudeModeFooters,
  ClaudeDefaultRung,
  PermissionCycleCSI,
} from "./fakeharness.ts";
import { KeyRecorder, newTestConv, trustRequest } from "./helpers.ts";

const dec = new TextDecoder();

/** A short settle window so the quiescent branch costs milliseconds, not 750ms. */
const testSettle = 60;

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

// ── frame painting ───────────────────────────────────────────────────────────

/** Clear-and-home, so each frame REPLACES the last rather than scrolling. */
function paint(...lines: string[]): string {
  return "\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n";
}

/**
 * A settled, ready claude composer carrying `footer` as its bottom-most line —
 * the minimum readyForInput("claude-code", …) accepts (the "Claude Code" header
 * plus a "❯" alone on its own line) plus the mode footer the parser scrapes.
 */
function ccFrame(footer: string): string {
  return paint("Claude Code", "", "❯", "", footer);
}

const rungFrame = (rung: PermissionRung): string =>
  ccFrame(ClaudeModeFooters[rung]);

/** Ready composer with NO mode footer at all -> source "no_footer". */
const noFooterFrame = paint("Claude Code", "", "❯", "");

/**
 * A mode-footer line that IS painted and does NOT parse -> "unparsed_footer".
 * The glyph probe matches (glyph + horizontal whitespace); the fragment regex
 * needs a leading letter, which "???" has not got.
 */
const unparsedFooterFrame = ccFrame("⏸ ??? ???");

/**
 * An OFF-LADDER but perfectly legible footer: claude's flag-only `dontAsk`,
 * which is not on the Shift+Tab ring. Parses to observed "unknown" WITH a
 * non-empty raw — "somewhere the ladder can't name", not "we couldn't see".
 */
const dontAskFrame = ccFrame("⏸ dontAsk mode on (shift+tab to cycle)");

/** claude's Bypass Permissions acceptance screen: blocking, and no rung footer. */
const bypassDialogFrame = paint(
  "Claude Code",
  "",
  "╭────────────────────────────────────────╮",
  "│ Bypass Permissions mode                │",
  "│ ❯ 1. No, exit                          │",
  "│   2. Yes, I accept                     │",
  "╰────────────────────────────────────────╯",
);

// ── the synthetic ring driver ────────────────────────────────────────────────

interface RingOptions {
  /** The rung the session starts on. */
  start?: PermissionRung;
  /**
   * What each successive press paints, in order. `null` means "paint nothing"
   * (the press does not take). Exhausting the list means every further press
   * paints nothing.
   */
  presses?: (PermissionRung | null)[];
  /** Extra Conversation options (args, permissionMode, permissionSettle, …). */
  opts?: Record<string, unknown>;
  /** Repaints per new value. 2 (default) exercises the two-generation rule; 1 the gap. */
  repaints?: number;
  /** Frames painted BEFORE the new value, at the OLD value or with no footer. */
  interstitial?: (index: number) => string[];
  /** Delay (ms) before the answering frames land. */
  delayMs?: number;
  /** Called after press `index` (1-based) instead of painting. */
  onPress?: (index: number, conv: Conversation, screen: Screen) => boolean;
}

interface Ring {
  conv: Conversation;
  rec: KeyRecorder;
  screen: Screen;
  /** Cycle keystrokes written so far. */
  presses(): number;
  /** Bytes recorded so far — snapshot one before a call to assert a DELTA. */
  bytes(): number;
}

/**
 * Builds a claude-code Conversation whose writeStdin sink answers each cycle
 * keystroke by painting the next frame, the way the real TUI repaints its footer.
 */
function newRing(o: RingOptions = {}): Ring {
  const screen = newScreen(120, 40);
  const rec = new KeyRecorder();
  const repaints = o.repaints ?? 2;
  const steps = o.presses ?? [];
  let pressCount = 0;
  // The sink runs before newTestConv returns the handle it needs, so the
  // conversation is reached through a holder rather than captured directly.
  const holder: { conv?: Conversation } = {};

  const sink = (p: Uint8Array): void => {
    rec.write(p);
    if (dec.decode(p) !== PermissionCycleCSI) return;
    const index = ++pressCount;
    const step = async (): Promise<void> => {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.onPress?.(index, holder.conv!, screen)) return;
      for (const f of o.interstitial?.(index) ?? []) await screen.write(f);
      const next = index <= steps.length ? steps[index - 1] : null;
      if (next === null) return;
      for (let i = 0; i < repaints; i++) await screen.write(rungFrame(next));
    };
    void step();
  };

  const conv = newTestConv(
    {
      harness: "claude-code",
      permissionSettle: testSettle,
      ...o.opts,
    },
    rec,
    {
      screen,
      adapter: claudecode.New(),
      eventCh: new EventBus(8),
      writeStdin: sink,
    },
  );
  holder.conv = conv;

  return {
    conv,
    rec,
    screen,
    presses: () => pressCount,
    bytes: () => rec.data.length,
  };
}

/** Paints the starting frame and takes the control token, as a caller would. */
async function armed(
  r: Ring,
  start: PermissionRung = ClaudeDefaultRung,
): Promise<() => void> {
  await r.screen.write(rungFrame(start));
  return r.conv.acquireControl(Context.background());
}

// ── the synthetic codex driver ───────────────────────────────────────────────
//
// codex's collaboration axis is NOT repainted on its own: it is legible only
// from a `/status` box, which is printed once when `/status` is submitted and
// then just sits there. So this driver answers a `/status` burst with a box
// carrying the CURRENT collaboration value, and answers a Shift+Tab by flipping
// that value and painting NOTHING — which is what makes the stale box left over
// from the previous probe the default hazard rather than an exotic one.

/** The exact burst CodexAdapter.primeSessionIDKeys() writes: `/status` + CSI 13u. */
const CodexStatusBurst = dec.decode(codex.New().primeSessionIDKeys());

const codexUUID = "019f4118-0000-7013-a43a-000000000118";

/** The box's inner width — wide enough that every row renders unwrapped. */
const codexBoxInner = 93;

/** A settled, ready codex composer with NO `/status` box on screen. */
const codexReadyFrame = paint(
  "Codex",
  "",
  "› ",
  "",
  "  codex resume " + codexUUID,
);

/**
 * A `/status` box reporting `collaboration`, with the `Permissions:` row FIXED:
 * the two axes move independently, and a codex press must never be confirmed off
 * the permissions row.
 */
function codexStatusFrame(collaboration: "Default" | "Plan"): string {
  const row = (t: string): string =>
    "│" + t.padEnd(codexBoxInner, " ").slice(0, codexBoxInner) + "│";
  const rule = "─".repeat(codexBoxInner);
  return paint(
    ">_ OpenAI Codex (v0.144.5)",
    "",
    "╭" + rule + "╮",
    row("  Permissions:          Workspace (Ask for approval)"),
    row("  Collaboration mode:   " + collaboration),
    row("  Session:              " + codexUUID),
    "╰" + rule + "╯",
    "",
    "› ",
    "",
  );
}

interface CodexRingOptions {
  /** The collaboration mode the live box reports before any press. */
  start?: "Default" | "Plan";
  /** Withhold the box for the first N `/status` bursts (drives the resend). */
  withhold?: number;
  /** Extra Conversation options (cols, primeBound, permissionMode, …). */
  opts?: Record<string, unknown>;
}

interface CodexRing {
  conv: Conversation;
  rec: KeyRecorder;
  screen: Screen;
  /** `/status` bursts written so far. */
  bursts(): number;
  /** Cycle keystrokes written so far. */
  presses(): number;
  /** Bytes recorded so far — snapshot one before a call to assert a DELTA. */
  bytes(): number;
}

function newCodexRing(o: CodexRingOptions = {}): CodexRing {
  const screen = newScreen(120, 40);
  const rec = new KeyRecorder();
  const withhold = o.withhold ?? 0;
  let collaboration: "Default" | "Plan" = o.start ?? "Default";
  let bursts = 0;
  let presses = 0;

  const sink = (p: Uint8Array): void => {
    rec.write(p);
    const s = dec.decode(p);
    if (s === PermissionCycleCSI) {
      presses++;
      // The session-local 2-cycle. Nothing repaints: the box already on screen
      // keeps reporting the PRE-press value until the next probe replaces it.
      collaboration = collaboration === "Default" ? "Plan" : "Default";
      return;
    }
    if (s !== CodexStatusBurst) return;
    const n = ++bursts;
    void (async () => {
      if (n <= withhold) return;
      await screen.write(codexStatusFrame(collaboration));
    })();
  };

  const conv = newTestConv(
    {
      harness: "codex",
      cols: 120,
      rows: 40,
      // The probe bound (and so the halfway resend mark), kept short.
      primeBound: 400,
      ...o.opts,
    },
    rec,
    {
      screen,
      adapter: codex.New(),
      eventCh: new EventBus(8),
      writeStdin: sink,
    },
  );

  return {
    conv,
    rec,
    screen,
    bursts: () => bursts,
    presses: () => presses,
    bytes: () => rec.data.length,
  };
}

/** Paints the ready composer and takes the control token, as a caller would. */
async function armedCodex(r: CodexRing): Promise<() => void> {
  await r.screen.write(codexReadyFrame);
  return r.conv.acquireControl(Context.background());
}

/** The reading 102 caches at prime time, seeded directly for the staleness tests. */
function seedPrimeReading(
  conv: Conversation,
  reading: PermissionModeReading,
): void {
  (
    conv as unknown as { primeModeReading?: PermissionModeReading }
  ).primeModeReading = reading;
}

// ── the axis accessor ────────────────────────────────────────────────────────

describe("permissionAxisValue", () => {
  const reading = (
    over: Partial<PermissionModeReading>,
  ): PermissionModeReading => ({
    observed: "manual",
    source: "footer",
    generation: 1,
    observedAt: new Date(0),
    ...over,
  });

  function axis(harness: string, r: PermissionModeReading): string {
    const c = new Conversation({ opts: { harness }, adapter: generic.New() });
    return (
      c as unknown as {
        permissionAxisValue(h: string, x: PermissionModeReading): string;
      }
    ).permissionAxisValue(harness, r);
  }

  // The two axes DO NOT collapse: `observed` is the permissions ladder,
  // `collaboration` is a separate field. Reading the wrong one is the failure
  // that would end every codex call in a backstop stall.
  test("claude-code reads `observed`, never `collaboration`", () => {
    expect(
      axis(
        "claude-code",
        reading({ observed: "plan", collaboration: "default" }),
      ),
    ).toBe("plan");
  });

  test("codex reads `collaboration`, never `observed`", () => {
    expect(
      axis(
        "codex",
        reading({ observed: "acceptEdits", collaboration: "plan" }),
      ),
    ).toBe("plan");
    // Absence is NOT a signal — a missing Collaboration row is "unknown".
    expect(axis("codex", reading({ observed: "auto" }))).toBe("unknown");
  });

  test("a harness with no cycle axis reports unknown, not `observed`", () => {
    expect(axis("generic", reading({ observed: "auto" }))).toBe("unknown");
  });
});

// ── adapter / fake drift ─────────────────────────────────────────────────────

describe("the cycle keystroke", () => {
  // If these two ever diverge, every fake-driven test would pass against bytes
  // the real harness never sees.
  test("the claude adapter pins exactly the fake's PermissionCycleCSI", () => {
    expect(dec.decode(claudecode.New().permissionCycleKeys())).toBe(
      PermissionCycleCSI,
    );
  });

  test("the codex adapter pins the same sequence", () => {
    expect(dec.decode(codex.New().permissionCycleKeys())).toBe(
      PermissionCycleCSI,
    );
  });
});

// ── the happy path ───────────────────────────────────────────────────────────

describe("setPermissionMode: the claude ring", () => {
  const ring: PermissionRung[] = ["auto", "manual", "acceptEdits", "plan"];
  const after = (start: PermissionRung, n: number): PermissionRung =>
    ring[(ring.indexOf(start) + n) % ring.length];

  for (const start of ring) {
    for (const target of ring) {
      if (target === start) continue;
      test(`${start} -> ${target}`, async () => {
        const steps = ring.length - 1;
        const r = newRing({
          presses: Array.from({ length: steps }, (_, i) => after(start, i + 1)),
        });
        const release = await armed(r, start);
        try {
          const got = await r.conv.setPermissionMode(
            Context.background(),
            target,
          );
          // The loop's ONLY success predicate is 102's reading on the axis
          // accessor's field.
          expect(got.observed).toBe(target);
          expect(got.source).toBe("footer");
          // It never overshoots: exactly as many presses as the ring distance.
          const distance =
            (ring.indexOf(target) - ring.indexOf(start) + ring.length) %
            ring.length;
          expect(r.presses()).toBe(distance);
        } finally {
          release();
        }
      });
    }
  }

  // The fresh-session default is the ONE footer without "(shift+tab to cycle)",
  // so starting here is also the suffix-less-parse regression.
  test("starts from the fresh-session default `manual`, read positively", async () => {
    const r = newRing({ presses: ["acceptEdits"] });
    const release = await armed(r, "manual");
    try {
      expect(r.conv.permissionMode().observed).toBe("manual");
      expect(r.conv.permissionMode().raw).toBe("manual mode on");
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });

  // requested is a LAUNCH fact. A successful switch does NOT rewrite it, so
  // requested !== observed afterwards is expected drift, not a bug.
  test("a successful switch does not rewrite `requested`", async () => {
    const r = newRing({
      presses: ["acceptEdits"],
      opts: { permissionMode: "manual" },
    });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      expect(got.requested).toBe("manual");
      expect(r.conv.permissionMode().requested).toBe("manual");
    } finally {
      release();
    }
  });
});

// ── the no-op ────────────────────────────────────────────────────────────────

describe("setPermissionMode: no-op", () => {
  test("target already on the axis writes ZERO cycle keystrokes", async () => {
    const r = newRing();
    const release = await armed(r, "plan");
    try {
      const before = r.bytes();
      const got = await r.conv.setPermissionMode(Context.background(), "plan");
      expect(got.observed).toBe("plan");
      expect(r.bytes() - before).toBe(0);
      expect(r.presses()).toBe(0);
    } finally {
      release();
    }
  });

  test("idempotent by construction: two calls press at most once", async () => {
    const r = newRing({ presses: ["acceptEdits"] });
    const release = await armed(r, "manual");
    try {
      const ctx = Context.background();
      await r.conv.setPermissionMode(ctx, "acceptEdits");
      const between = r.bytes();
      const second = await r.conv.setPermissionMode(ctx, "acceptEdits");
      expect(second.observed).toBe("acceptEdits");
      expect(r.bytes() - between).toBe(0);
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });
});

// ── termination ──────────────────────────────────────────────────────────────

describe("setPermissionMode: termination", () => {
  test("a lapped ring is Unreachable and lists the values it saw", async () => {
    // Never lands on `auto`; comes back round to the start instead. Lap
    // detection is exact whatever the ring's length — no press count is assumed.
    const r = newRing({
      presses: ["acceptEdits", "plan", "manual"],
      opts: { args: ["--permission-mode", "manual"] },
    });
    const release = await armed(r, "manual");
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "auto"),
      );
      expect(isSentinel(err, ErrPermissionModeUnreachable)).toBe(true);
      const msg = String(err);
      expect(msg).toContain("lapped");
      for (const v of ["manual", "acceptEdits", "plan"])
        expect(msg).toContain(v);
      expect(r.presses()).toBe(3);
      // Only cycle keystrokes went out — the session is left on the rung the
      // harness painted, never on some unrequested one we typed towards.
      expect(dec.decode(r.rec.data)).toBe(PermissionCycleCSI.repeat(3));
    } finally {
      release();
    }
  });

  test("the flat press backstop is Stalled and names the press count", async () => {
    // A ring that neither laps back to `manual` nor reaches `bypass`.
    const r = newRing({
      presses: [
        "acceptEdits",
        "plan",
        "auto",
        "acceptEdits",
        "plan",
        "auto",
        "acceptEdits",
        "plan",
        "auto",
      ],
      // bypass IS launch-enabled, so the fast-fail does not pre-empt the loop.
      opts: { permissionMode: "bypass" },
    });
    const release = await armed(r, "manual");
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "bypass"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("8-press backstop");
      expect(r.presses()).toBe(8);
    } finally {
      release();
    }
  });

  test("the ctx deadline is Stalled and buys no extra press", async () => {
    // The answering frame lands well after the deadline.
    const r = newRing({
      presses: ["acceptEdits", "plan"],
      delayMs: 400,
      opts: { permissionSettle: 5000 },
    });
    const release = await armed(r, "manual");
    try {
      const { ctx, cancel } = Context.withDeadline(Context.background(), 60);
      try {
        const err = await caught(r.conv.setPermissionMode(ctx, "plan"));
        expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
        expect(String(err)).toContain("deadline");
        expect(r.presses()).toBe(1);
      } finally {
        cancel();
      }
    } finally {
      release();
    }
  });

  // Gate 5 waits under awaitPromptReadyUntil rather than writing blind. When the
  // composer never arrives the ctx bound is still reported in this method's own
  // vocabulary — Stalled — not as a bare ctx error, and nothing is written.
  test("a composer that never becomes ready is Stalled with zero keystrokes", async () => {
    const r = newRing();
    // A blocking dialog: readyForInput false, and no rung footer.
    await r.screen.write(bypassDialogFrame);
    const release = await r.conv.acquireControl(Context.background());
    try {
      const { ctx, cancel } = Context.withDeadline(Context.background(), 60);
      try {
        const before = r.bytes();
        const err = await caught(r.conv.setPermissionMode(ctx, "plan"));
        expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
        expect(String(err)).toContain("never reached a ready prompt");
        expect(r.bytes() - before).toBe(0);
      } finally {
        cancel();
      }
    } finally {
      release();
    }
  });

  test("a press that does not take is Stalled, not a silent re-press", async () => {
    const r = newRing({ presses: [null] });
    const release = await armed(r, "manual");
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("did not change");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });
});

// ── the settle window ────────────────────────────────────────────────────────

describe("setPermissionMode: the per-press settle", () => {
  // The double-advance regression. "Write, re-read, repeat" as literally written
  // races the render, sees the PRE-press value, presses again and overshoots.
  test("stale pre-press frames never trigger a second press", async () => {
    const r = newRing({
      presses: ["acceptEdits"],
      delayMs: 15,
      // Two further renders still carrying the OLD footer, exactly what a naive
      // immediate re-read would latch onto.
      interstitial: () => [rungFrame("manual"), rungFrame("manual")],
    });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });

  // Stability is the GENERATION, and the timer is only the bound: a value that
  // gets a second generation is accepted at once...
  test("two distinct generations accept without waiting out the gap", async () => {
    const r = newRing({
      presses: ["acceptEdits"],
      repaints: 2,
      opts: { permissionSettle: 5000 },
    });
    const release = await armed(r, "manual");
    try {
      const t0 = Date.now();
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      // Nowhere near the 5s gap: the second generation resolved it.
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      release();
    }
  });

  // ...and a value that will NEVER get a second generation is still accepted,
  // via the quiescent bound.
  test("a single quiescent generation is accepted via permissionSettleGap", async () => {
    const r = newRing({ presses: ["acceptEdits"], repaints: 1 });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });
});

// ── reading failures, keyed on `source` ──────────────────────────────────────

describe("setPermissionMode: reading failures", () => {
  // Aborting on observed === "unknown" would kill the call on ONE mid-render
  // frame — the precise failure the settle window exists to prevent.
  test("a single no_footer frame mid-settle does not abort the call", async () => {
    const r = newRing({
      presses: ["acceptEdits"],
      delayMs: 10,
      interstitial: () => [noFooterFrame],
    });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "acceptEdits",
      );
      expect(got.observed).toBe("acceptEdits");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });

  test("unparsed_footer is Stalled and carries the raw line", async () => {
    const r = newRing();
    await r.screen.write(unparsedFooterFrame);
    const release = await r.conv.acquireControl(Context.background());
    try {
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("unparsed_footer");
      expect(String(err)).toContain("??? ???");
      expect(r.bytes() - before).toBe(0);
    } finally {
      release();
    }
  });

  // The codex prime-outcome sources cannot be reached through setPermissionMode
  // until the follow-on subtask wires the codex branch, so the classifier is
  // exercised directly rather than through a test that would have to be deleted.
  for (const source of [
    "too_narrow",
    "not_primed",
    "not_written",
    "written_uncaptured",
  ] as const) {
    test(`${source} is Stalled and carries the source`, () => {
      const c = new Conversation({
        opts: { harness: "claude-code" },
        adapter: claudecode.New(),
      });
      const err = (
        c as unknown as {
          permissionReadingError(
            h: string,
            r: PermissionModeReading,
          ): Error | null;
        }
      ).permissionReadingError("claude-code", {
        observed: "unknown",
        source,
        generation: 3,
        observedAt: new Date(0),
      });
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain(source);
    });
  }

  test("no_footer is transient: the classifier says keep waiting", () => {
    const c = new Conversation({
      opts: { harness: "claude-code" },
      adapter: claudecode.New(),
    });
    const err = (
      c as unknown as {
        permissionReadingError(
          h: string,
          r: PermissionModeReading,
        ): Error | null;
      }
    ).permissionReadingError("claude-code", {
      observed: "unknown",
      source: "no_footer",
      generation: 3,
      observedAt: new Date(0),
    });
    expect(err).toBeNull();
  });

  // An off-ladder START refuses BEFORE the first press: `start` is not a
  // comparable value, so lap detection could never close.
  test("an off-ladder start is Unreachable, quoting raw, with zero keystrokes", async () => {
    const r = newRing({ opts: { permissionMode: "dontAsk" } });
    await r.screen.write(dontAskFrame);
    const release = await r.conv.acquireControl(Context.background());
    try {
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeUnreachable)).toBe(true);
      expect(String(err)).toContain("dontAsk mode on");
      expect(r.bytes() - before).toBe(0);
      expect(r.presses()).toBe(0);
    } finally {
      release();
    }
  });
});

// ── gating ───────────────────────────────────────────────────────────────────

describe("setPermissionMode: gating", () => {
  test("ErrClosed after close", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec, {
      adapter: claudecode.New(),
      closed: true,
    });
    expect(
      isSentinel(
        await caught(c.setPermissionMode(Context.background(), "plan")),
        ErrClosed,
      ),
    ).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("ErrNoControl without the token", async () => {
    const r = newRing();
    await r.screen.write(rungFrame("manual"));
    const before = r.bytes();
    expect(
      isSentinel(
        await caught(r.conv.setPermissionMode(Context.background(), "plan")),
        ErrNoControl,
      ),
    ).toBe(true);
    expect(r.bytes() - before).toBe(0);
  });

  test("ErrTurnInFlight while a turn is running", async () => {
    const r = newRing();
    const release = await armed(r, "manual");
    try {
      r.conv.currentTurn = {
        id: "t-1",
        sessionID: "s-1",
        role: RoleAssistant,
        state: TurnStatePending,
        text: "",
        reason: "",
        startedAt: new Date(),
        completedAt: new Date(0),
        httpCode: 0,
        retryAfter: 0,
      };
      const before = r.bytes();
      expect(
        isSentinel(
          await caught(r.conv.setPermissionMode(Context.background(), "plan")),
          ErrTurnInFlight,
        ),
      ).toBe(true);
      expect(r.bytes() - before).toBe(0);
    } finally {
      r.conv.currentTurn = null;
      release();
    }
  });

  test("ErrInputPending names the pending kind and the escape hatch", async () => {
    const r = newRing();
    const release = await armed(r, "manual");
    try {
      r.conv.handleInputRequested(trustRequest());
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrInputPending)).toBe(true);
      expect(String(err)).toContain("trust_prompt");
      expect(String(err)).toContain("answer()");
      expect(r.bytes() - before).toBe(0);
    } finally {
      release();
    }
  });

  // THE DEADLOCK REGRESSION. The gateway mints the control token by HOLDING the
  // ControlQueue, so an acquire() inside setPermissionMode would park an HTTP
  // caller behind its own token until the request deadline. This call is made
  // while the caller holds the token and must complete regardless.
  test("completes while the caller holds the token", async () => {
    const r = newRing({ presses: ["acceptEdits"] });
    const release = await armed(r, "manual");
    try {
      expect(r.conv.queue.held()).toBe(true);
      const raced = await Promise.race([
        r.conv.setPermissionMode(Context.background(), "acceptEdits"),
        new Promise<"blocked">((res) => {
          setTimeout(() => {
            res("blocked");
          }, 3000);
        }),
      ]);
      expect(raced).not.toBe("blocked");
      expect((raced as PermissionModeReading).observed).toBe("acceptEdits");
      // Still held: the method never took (nor released) the token itself.
      expect(r.conv.queue.held()).toBe(true);
    } finally {
      release();
    }
  });

  // A dialog can appear MID-TRAVERSAL. Without the mid-loop re-check the loop
  // would sit here and report a stall while leaving the session in a modal.
  test("a bypass dialog mid-ring is ErrInputPending, NOT Stalled", async () => {
    const r = newRing({
      opts: { args: ["--dangerously-skip-permissions"] },
      onPress: (_i, conv, screen) => {
        void (async () => {
          await screen.write(bypassDialogFrame);
          // What the turns layer reports for this screen.
          conv.handleInputRequested({
            id: "req-bypass",
            kind: "trust_prompt",
            prompt: "Bypass Permissions mode",
            options: [
              { id: "1", alias: "", label: "No, exit", keys: new Uint8Array() },
              {
                id: "2",
                alias: "",
                label: "Yes, I accept",
                keys: new Uint8Array(),
              },
            ],
          });
        })();
        return true;
      },
    });
    const release = await armed(r, "manual");
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "bypass"),
      );
      expect(isSentinel(err, ErrInputPending)).toBe(true);
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(false);
      expect(String(err)).toContain("trust_prompt");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });
});

// ── the bypass fast-fail ─────────────────────────────────────────────────────

describe("setPermissionMode: bypass", () => {
  test("refused with a ZERO delta on a non-bypass-enabled session", async () => {
    const r = newRing();
    const release = await armed(r, "manual");
    try {
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "bypass"),
      );
      expect(isSentinel(err, ErrPermissionModeUnreachable)).toBe(true);
      expect(String(err)).toContain("bypass is not enabled");
      expect(r.bytes() - before).toBe(0);
      expect(r.presses()).toBe(0);
    } finally {
      release();
    }
  });

  // (a) argv — including the `=`-joined spelling a naive scanner misses.
  test("accepted with --permission-mode=bypassPermissions in args", async () => {
    const r = newRing({
      presses: ["bypass"],
      opts: { args: ["--permission-mode=bypassPermissions"] },
    });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "bypass",
      );
      expect(got.observed).toBe("bypass");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });

  test("accepted with --dangerously-skip-permissions in args", async () => {
    const r = newRing({
      presses: ["bypass"],
      opts: { args: ["--dangerously-skip-permissions"] },
    });
    const release = await armed(r, "manual");
    try {
      expect(
        (await r.conv.setPermissionMode(Context.background(), "bypass"))
          .observed,
      ).toBe("bypass");
    } finally {
      release();
    }
  });

  // (b) the STRUCTURED option with EMPTY args — the case an args-only predicate
  // gets wrong, on precisely the sessions where bypass IS reachable.
  test("accepted with the structured permissionMode option and empty args", async () => {
    const r = newRing({
      presses: ["bypass"],
      opts: { permissionMode: "bypass", args: [] },
    });
    const release = await armed(r, "manual");
    try {
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "bypass",
      );
      expect(got.observed).toBe("bypass");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });
});

// ── unsupported harnesses / off-axis targets ─────────────────────────────────

describe("setPermissionMode: unsupported", () => {
  for (const [name, adapter] of [
    ["opencode", opencode.New()],
    ["pi", pi.New()],
    ["generic", generic.New()],
  ] as const) {
    test(`${name} has no cycle keystroke -> Unsupported, zero bytes`, async () => {
      const rec = new KeyRecorder();
      const c = newTestConv({ harness: name }, rec, { adapter });
      const release = await c.acquireControl(Context.background());
      try {
        expect(
          isSentinel(
            await caught(c.setPermissionMode(Context.background(), "plan")),
            ErrPermissionModeUnsupported,
          ),
        ).toBe(true);
        expect(rec.data.length).toBe(0);
      } finally {
        release();
      }
    });
  }

  // A LADDER RUNG on codex is launch-flag territory (`-s` / `-a`): the axis this
  // method drives there is the collaboration 2-cycle, and nothing else.
  for (const target of ["manual", "acceptEdits", "auto", "bypass"] as const) {
    test(`\`${target}\` on codex is Unreachable and names the collaboration axis`, async () => {
      const r = newCodexRing();
      const release = await armedCodex(r);
      try {
        const before = r.bytes();
        const err = await caught(
          r.conv.setPermissionMode(Context.background(), target),
        );
        expect(isSentinel(err, ErrPermissionModeUnreachable)).toBe(true);
        expect(String(err)).toContain("collaboration");
        expect(String(err)).toContain("default | plan");
        // Not even the `/status` probe: the legality check is a pure fact about
        // the harness and runs before anything is written.
        expect(r.bytes() - before).toBe(0);
        expect(r.bursts()).toBe(0);
        expect(r.presses()).toBe(0);
      } finally {
        release();
      }
    });
  }

  // "default" is the codex COLLABORATION axis, not a ladder rung: the rule is
  // "Default when permissionMode is unset: inject nothing", and claude's actual
  // default is `manual`.
  test("`default` on claude is Unreachable and names the axis", async () => {
    const r = newRing();
    const release = await armed(r, "manual");
    try {
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "default"),
      );
      expect(isSentinel(err, ErrPermissionModeUnreachable)).toBe(true);
      expect(String(err)).toContain("permissions ladder");
      expect(r.bytes() - before).toBe(0);
    } finally {
      release();
    }
  });
});

// ── codex: the collaboration 2-cycle ─────────────────────────────────────────

describe("setPermissionMode: the codex collaboration axis", () => {
  // THE AXIS-COLLAPSE REGRESSION. 102's reading carries two axes that do not
  // collapse: watching `observed` (the permissions ladder) instead of
  // `collaboration` would make EVERY codex call end in ErrPermissionModeStalled
  // after the backstop, because the permissions row never moves.
  test("a toggle terminates on `collaboration` while `observed` stays put", async () => {
    const r = newCodexRing({ start: "Default" });
    const release = await armedCodex(r);
    try {
      const got = await r.conv.setPermissionMode(Context.background(), "plan");
      expect(got.collaboration).toBe("plan");
      expect(got.source).toBe("status");
      // The permissions axis is LAUNCH-flag territory and is unmoved: a
      // successful collaboration flip does NOT claim the epic's `plan` rung
      // (that also needs `-s read-only -a untrusted`).
      expect(got.observed).toBe("acceptEdits");
      expect(got.raw).toBe("Workspace (Ask for approval)");
      expect(r.presses()).toBe(1);
    } finally {
      release();
    }
  });

  for (const [start, target, want] of [
    ["Default", "plan", "plan"],
    ["Plan", "default", "default"],
  ] as const) {
    test(`${start} -> ${target}: one press, two /status probes`, async () => {
      const r = newCodexRing({ start });
      const release = await armedCodex(r);
      try {
        const before = r.bytes();
        const got = await r.conv.setPermissionMode(
          Context.background(),
          target,
        );
        expect(got.collaboration).toBe(want);
        expect(r.presses()).toBe(1);
        expect(r.bursts()).toBe(2);
        // The BOUNDED COST, asserted as the recorder's DELTA across the call:
        // probe, press, probe — and nothing else. Never a total: KeyRecorder is
        // the whole writeStdin sink and also records the auto-dismiss pump.
        expect(dec.decode(r.rec.data.slice(before))).toBe(
          CodexStatusBurst + PermissionCycleCSI + CodexStatusBurst,
        );
      } finally {
        release();
      }
    });
  }

  // The no-op has to be decided from a FRESH probe, never from the prime-time
  // cache: that cache is unbounded-stale (and `not_primed` outright on a resumed
  // session). A session already in Default whose cache says Plan would otherwise
  // be pressed into Plan and back — the silent-wrong-mode window this closes.
  test("codex `default` start: the probe runs BEFORE the first press", async () => {
    const r = newCodexRing({ start: "Default" });
    seedPrimeReading(r.conv, {
      observed: "acceptEdits",
      raw: "Workspace (Ask for approval)",
      collaboration: "plan", // STALE, and the opposite of the live box
      source: "status",
      generation: 1,
      observedAt: new Date(0),
    });
    const release = await armedCodex(r);
    try {
      const before = r.bytes();
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "default",
      );
      expect(got.collaboration).toBe("default");
      // ZERO cycle keystrokes; exactly ONE /status burst, and those bytes are
      // the adapter's capability verbatim.
      expect(r.presses()).toBe(0);
      expect(r.bursts()).toBe(1);
      expect(dec.decode(r.rec.data.slice(before))).toBe(CodexStatusBurst);
      // The stale cache was REPLACED, not merely bypassed.
      expect(r.conv.permissionMode().collaboration).toBe("default");
      expect(r.conv.permissionMode().generation).toBe(got.generation);
      expect(got.generation).toBeGreaterThan(1);
    } finally {
      release();
    }
  });

  // The /status write is flaky enough that the primer already re-sent once at
  // the halfway mark; the refresh path inherits the same treatment through the
  // shared helper. At most ONE resend — the latch is consumed either way.
  test("the box withheld past the half mark: exactly one resend, then success", async () => {
    const r = newCodexRing({ withhold: 1, opts: { primeBound: 300 } });
    const release = await armedCodex(r);
    try {
      const before = r.bytes();
      const got = await r.conv.setPermissionMode(
        Context.background(),
        "default",
      );
      expect(got.collaboration).toBe("default");
      expect(r.bursts()).toBe(2);
      expect(r.presses()).toBe(0);
      expect(dec.decode(r.rec.data.slice(before))).toBe(
        CodexStatusBurst.repeat(2),
      );
    } finally {
      release();
    }
  });

  // A box that never renders is a stall, not a blind press.
  test("a box that never renders is Stalled with zero cycle keystrokes", async () => {
    const r = newCodexRing({ withhold: 99, opts: { primeBound: 150 } });
    const release = await armedCodex(r);
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("could not read the permission axis");
      expect(r.presses()).toBe(0);
    } finally {
      release();
    }
  });

  // A press that does not take: the box comes back reporting the SAME
  // collaboration value, so the confirm refuses it rather than accepting the
  // stale reading as a success.
  test("a press that does not take is Stalled, never confirmed off the stale box", async () => {
    const r = newCodexRing({ start: "Default", opts: { primeBound: 200 } });
    // Neutralize the flip: every probe now paints Default, forever.
    const conv = r.conv;
    const sink = conv.writeStdin!;
    conv.writeStdin = (p: Uint8Array): void => {
      if (dec.decode(p) === PermissionCycleCSI) {
        r.rec.write(p); // recorded, but the harness ignores it
        return;
      }
      sink(p);
    };
    const release = await armedCodex(r);
    try {
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("did not change");
      expect(r.conv.permissionMode().collaboration).toBe("default");
    } finally {
      release();
    }
  });

  test("a too-narrow CONFIGURED width is Stalled before anything is written", async () => {
    // The width guard reads opts.cols — the CONFIGURED width, not a live
    // measurement. That is exactly what source "too_narrow" means.
    const r = newCodexRing({ opts: { cols: 40 } });
    const release = await armedCodex(r);
    try {
      const before = r.bytes();
      const err = await caught(
        r.conv.setPermissionMode(Context.background(), "plan"),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("CODEX_STATUS_MIN_COLS");
      expect(r.bytes() - before).toBe(0);
      expect(r.bursts()).toBe(0);
    } finally {
      release();
    }
  });
});

// ── refreshPermissionMode ────────────────────────────────────────────────────

describe("refreshPermissionMode", () => {
  // The write-back is the whole point: 102's permissionMode() on codex is a pure
  // read of the cached prime-time reading, and so is the gateway's GET route. A
  // refresh that returned a fresh value without writing it back would leave the
  // two disagreeing.
  test("codex: re-probes, WRITES BACK, and the pure GET read agrees", async () => {
    const r = newCodexRing({ start: "Plan" });
    const release = await armedCodex(r);
    try {
      // The permanently-unobserved state every resumed/reopened codex session
      // is in: the primer never ran, so there is nothing cached to read.
      expect(r.conv.permissionMode().source).toBe("not_primed");
      expect(r.conv.permissionMode().collaboration).toBe("unknown");

      const before = r.bytes();
      const got = await r.conv.refreshPermissionMode(Context.background());
      expect(got.collaboration).toBe("plan");
      expect(got.source).toBe("status");
      expect(dec.decode(r.rec.data.slice(before))).toBe(CodexStatusBurst);
      expect(r.presses()).toBe(0);

      const snap = r.conv.screenSnapshot();
      const dto = permissionModeResponse(
        r.conv.permissionMode(snap),
        snap.generation,
      );
      expect(dto.collaboration).toBe("plan");
      expect(dto.source).toBe("status");
      expect(dto.generation).toBe(got.generation);
      expect(dto.stale).toBe(false);
    } finally {
      release();
    }
  });

  // THE DEADLOCK CARVE-OUT. The shared probe must NOT acquire the queue: the
  // gateway mints the control token by HOLDING the non-reentrant ControlQueue,
  // so an acquire here would park an HTTP caller behind its own token.
  test("never calls queue.acquire, and completes while the caller holds the token", async () => {
    const r = newCodexRing();
    const q = r.conv.queue;
    const real = q.acquire.bind(q);
    let acquires = 0;
    (q as unknown as { acquire: typeof q.acquire }).acquire = (ctx) => {
      acquires++;
      return real(ctx);
    };
    const release = await armedCodex(r); // the CALLER's acquire
    const baseline = acquires;
    try {
      expect(r.conv.queue.held()).toBe(true);
      const raced = await Promise.race([
        r.conv.refreshPermissionMode(Context.background()),
        new Promise<"blocked">((res) => {
          setTimeout(() => {
            res("blocked");
          }, 3000);
        }),
      ]);
      expect(raced).not.toBe("blocked");
      expect((raced as PermissionModeReading).collaboration).toBe("default");
      expect(acquires - baseline).toBe(0);
      // Still held: the method never took (nor released) the token itself.
      expect(r.conv.queue.held()).toBe(true);
    } finally {
      release();
    }
  });

  test("codex: a box that never renders is Stalled, leaving the cache untouched", async () => {
    const r = newCodexRing({ withhold: 99, opts: { primeBound: 150 } });
    seedPrimeReading(r.conv, {
      observed: "bypass",
      raw: "Full Access",
      collaboration: "default",
      source: "status",
      generation: 7,
      observedAt: new Date(0),
    });
    const release = await armedCodex(r);
    try {
      const err = await caught(
        r.conv.refreshPermissionMode(Context.background()),
      );
      expect(isSentinel(err, ErrPermissionModeStalled)).toBe(true);
      expect(String(err)).toContain("refreshPermissionMode");
      const still = r.conv.permissionMode();
      expect(still.collaboration).toBe("default");
      expect(still.generation).toBe(7);
    } finally {
      release();
    }
  });

  // On claude 102's read is a strict LIVE per-call footer parse that caches
  // nothing, so there is nothing to re-probe — for EVERY rung, `manual`
  // included. A plain alias, and it writes not one byte.
  for (const rung of ["manual", "plan", "acceptEdits", "auto"] as const) {
    test(`claude: a plain alias for permissionMode() on \`${rung}\``, async () => {
      const r = newRing();
      const release = await armed(r, rung);
      try {
        const before = r.bytes();
        const got = await r.conv.refreshPermissionMode(Context.background());
        expect(got.observed).toBe(rung);
        expect(got.source).toBe("footer");
        expect(got.observed).toBe(r.conv.permissionMode().observed);
        expect(r.bytes() - before).toBe(0);
      } finally {
        release();
      }
    });
  }

  test("the same gates as setPermissionMode: closed, token, turn, pending input", async () => {
    const closedRec = new KeyRecorder();
    const closedConv = newTestConv({ harness: "codex" }, closedRec, {
      adapter: codex.New(),
      closed: true,
    });
    expect(
      isSentinel(
        await caught(closedConv.refreshPermissionMode(Context.background())),
        ErrClosed,
      ),
    ).toBe(true);
    expect(closedRec.data.length).toBe(0);

    const r = newCodexRing();
    await r.screen.write(codexReadyFrame);
    expect(
      isSentinel(
        await caught(r.conv.refreshPermissionMode(Context.background())),
        ErrNoControl,
      ),
    ).toBe(true);
    expect(r.bursts()).toBe(0);

    const release = await armedCodex(r);
    try {
      r.conv.currentTurn = {
        id: "t-1",
        sessionID: "s-1",
        role: RoleAssistant,
        state: TurnStatePending,
        text: "",
        reason: "",
        startedAt: new Date(),
        completedAt: new Date(0),
        httpCode: 0,
        retryAfter: 0,
      };
      expect(
        isSentinel(
          await caught(r.conv.refreshPermissionMode(Context.background())),
          ErrTurnInFlight,
        ),
      ).toBe(true);
      r.conv.currentTurn = null;

      r.conv.handleInputRequested(trustRequest());
      expect(
        isSentinel(
          await caught(r.conv.refreshPermissionMode(Context.background())),
          ErrInputPending,
        ),
      ).toBe(true);
      expect(r.bursts()).toBe(0);
    } finally {
      release();
    }
  });
});
