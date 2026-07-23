// Conversation.setPermissionMode() — the write side of the permission story:
// gating, held()-not-acquire() locking, the per-press settle loop, lap detection
// and the claude Shift+Tab ring (META-HARNESS-117).
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
