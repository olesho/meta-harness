// Conversation.setCodexPermissionPreset() — the opt-in, containment-gated
// driver for codex's `/permissions` "Update Model Permissions" dialog
// (META-HARNESS-103/127). The middle preset ("Approve for me") has no CLI
// spelling, so the dialog is the only way in — and committing a preset
// writes the user's GLOBAL ~/.codex/config.toml, which is why the method is
// opt-in AND fails closed unless the resolved adapter proves the write lands
// inside the exact isolated CODEX_HOME the caller named.
//
// Shape: the simple gates (0-7, the InputPolicy precondition) are asserted
// against a bare Conversation with an injected KeyRecorder, mirroring
// test/chat/quit.test.ts — no screen is touched before those gates fire, so
// none is wired.
//
// The sequence tests (dialog open/backout/commit/verify) need the REAL
// turn-watcher pipeline: setCodexPermissionPreset depends on
// currentInput/inputSurfaced, which only turns.Watch()'s screen pump
// (adapter.onScreen -> InputRequested/InputResolved) populates. Rather than
// spin a real PTY-driven fake harness process, this file wires
// turns.Watch(null, screen, adapter) directly onto a synthetic Screen — the
// same real onScreen()/DetectInput() pipeline Open() wires, but driven by a
// KeyRecorder-style sink that paints the next frame in response to specific
// bytes, the way test/chat/set_permission_mode.test.ts's newCodexRing does
// for setPermissionMode. Frame TEXT is generated from the fake-harness
// Builder's own painters (fakeharness.ts, landed by the sibling
// META-HARNESS-126 subtask) via frameText() below, so every screen shape
// byte-matches what the scripted PTY fake (and the live corpus recordings it
// mirrors) would paint — this file just skips the PTY transport.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Conversation, EventBus } from "../../src/chat/conversation.ts";
import {
  ErrClosed,
  ErrCodexHomeNotIsolated,
  ErrCodexPermissionsDisabled,
  ErrCodexPermissionsRaced,
  ErrInputPending,
  ErrInvalidOptions,
  ErrNoControl,
  ErrPermissionPresetUnavailable,
  ErrPermissionsUnsupported,
  ErrTurnInFlight,
  isSentinel,
} from "../../src/chat/errors.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import type { Session } from "../../src/chat/types.ts";
import { Context } from "../../src/internal/async/index.ts";
import { newScreen, type Screen } from "../../src/screen/index.ts";
import { Watch, codex, generic } from "../../src/turns/index.ts";
import { corpusBytes } from "../turns/corpus.ts";
import { KeyRecorder, newTestConv, trustRequest } from "./helpers.ts";
import { New } from "./fakeharness.ts";

const dec = new TextDecoder();

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

/**
 * Renders the LAST frame a fake-harness Builder chain paints, exactly the way
 * fakeharness.mjs would (CRLF, clear+home unless no_clear) — so a screen
 * painted this way byte-matches what a scripted PTY fake would show. Mirrors
 * fakeharness_permissions.test.ts's local paintedScreen() helper.
 */
function frameText(build: (b: ReturnType<typeof New>) => void): string {
  const b = New("codex");
  build(b);
  const steps = b.Build().steps;
  const last = steps[steps.length - 1]?.frame;
  if (!last) throw new Error("no frame step painted");
  let body = last.screen.split("\n").join("\r\n");
  if (!last.no_clear) body = "\x1b[2J\x1b[H" + body;
  return body;
}

const idleText = frameText((b) => b.Idle());

// ── Part A: zero-byte gates, no screen needed ───────────────────────────────

describe("setCodexPermissionPreset: zero-byte gates", () => {
  test("non-codex harness -> ErrPermissionsUnsupported, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: {
        harness: "claude-code",
        allowCodexPermissionsWrite: "/tmp/whatever",
      },
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrPermissionsUnsupported)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("codex harness, adapter stubbed WITHOUT the capability -> ErrPermissionsUnsupported, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: { harness: "codex", allowCodexPermissionsWrite: "/tmp/whatever" },
      adapter: generic.New(),
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrPermissionsUnsupported)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("caller-supplied Options.adapter + opt-in set -> ErrPermissionsUnsupported, zero bytes", async () => {
    const rec = new KeyRecorder();
    const suppliedAdapter = codex.New();
    const c = new Conversation({
      opts: {
        harness: "codex",
        adapter: suppliedAdapter,
        allowCodexPermissionsWrite: "/tmp/whatever",
      },
      adapter: suppliedAdapter,
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrPermissionsUnsupported)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("closed conversation -> ErrClosed, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: { harness: "codex", allowCodexPermissionsWrite: "/tmp/whatever" },
      adapter: codex.New(),
      writeStdin: rec.write,
      closed: true,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrClosed)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("inputPolicy.byKind.permissions_prompt set -> ErrInvalidOptions, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: {
        harness: "codex",
        allowCodexPermissionsWrite: "/tmp/whatever",
        inputPolicy: {
          byKind: {
            [codex.KindPermissions]: { kind: "answer", optionID: "1" },
          },
        },
      },
      adapter: codex.New(),
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrInvalidOptions)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("opt-in absent -> ErrCodexPermissionsDisabled, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: { harness: "codex" },
      adapter: codex.New(),
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrCodexPermissionsDisabled)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("opt-in empty string -> ErrCodexPermissionsDisabled, zero bytes", async () => {
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: { harness: "codex", allowCodexPermissionsWrite: "" },
      adapter: codex.New(),
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrCodexPermissionsDisabled)).toBe(true);
    expect(rec.data.length).toBe(0);
  });
});

// ── containment matrix ───────────────────────────────────────────────────────

describe("setCodexPermissionPreset: containment matrix", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function isolatedHome(): string {
    const d = mkdtempSync(join(tmpdir(), "codex-home-"));
    tmps.push(d);
    return d;
  }

  /** Binds a fresh codex adapter to `env`, then probes the containment gate. */
  async function probe(
    env: string[],
    allow: string,
  ): Promise<{ err: unknown; bytes: number }> {
    const rec = new KeyRecorder();
    const adapter = codex.New();
    adapter.bindLaunchEnv(env, "");
    const c = new Conversation({
      opts: { harness: "codex", allowCodexPermissionsWrite: allow },
      adapter,
      writeStdin: rec.write,
    });
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    return { err, bytes: rec.data.length };
  }

  test("CODEX_HOME unset -> ErrCodexHomeNotIsolated, zero bytes", async () => {
    const home = isolatedHome();
    const { err, bytes } = await probe(["HOME=" + homedir()], home);
    expect(isSentinel(err, ErrCodexHomeNotIsolated)).toBe(true);
    expect(bytes).toBe(0);
  });

  test("CODEX_HOME set but allowCodexPermissionsWrite names a DIFFERENT path (inherited-env case) -> ErrCodexHomeNotIsolated, zero bytes", async () => {
    const inherited = isolatedHome();
    const declared = isolatedHome();
    const { err, bytes } = await probe(["CODEX_HOME=" + inherited], declared);
    expect(isSentinel(err, ErrCodexHomeNotIsolated)).toBe(true);
    expect(bytes).toBe(0);
  });

  test("both set to the real ~/.codex -> ErrCodexHomeNotIsolated, zero bytes", async () => {
    const real = join(homedir(), ".codex");
    const { err, bytes } = await probe(["CODEX_HOME=" + real], real);
    expect(isSentinel(err, ErrCodexHomeNotIsolated)).toBe(true);
    expect(bytes).toBe(0);
  });

  test("happy path: both naming the same isolated tmp home -> gate passes (progresses to ErrNoControl)", async () => {
    const home = isolatedHome();
    const { err, bytes } = await probe(["CODEX_HOME=" + home], home);
    // No control token held: proves the containment gate itself did NOT fire.
    expect(isSentinel(err, ErrNoControl)).toBe(true);
    expect(bytes).toBe(0);
  });

  test("differing but equivalent spellings (trailing slash) still agree -> gate passes", async () => {
    const home = isolatedHome();
    const { err, bytes } = await probe(["CODEX_HOME=" + home], home + "/");
    expect(isSentinel(err, ErrNoControl)).toBe(true);
    expect(bytes).toBe(0);
  });

  test("differing but equivalent spellings (relative path) still agree -> gate passes", async () => {
    const home = isolatedHome();
    const rel = relative(process.cwd(), home);
    const { err, bytes } = await probe(["CODEX_HOME=" + home], rel);
    expect(isSentinel(err, ErrNoControl)).toBe(true);
    expect(bytes).toBe(0);
  });
});

// ── remaining ordering gates (control / turn / input) ───────────────────────

describe("setCodexPermissionPreset: control/turn/input gates", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function rig(): { c: Conversation; rec: KeyRecorder; home: string } {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    tmps.push(home);
    const adapter = codex.New();
    adapter.bindLaunchEnv([`CODEX_HOME=${home}`], "");
    const rec = new KeyRecorder();
    const c = new Conversation({
      opts: { harness: "codex", allowCodexPermissionsWrite: home },
      adapter,
      writeStdin: rec.write,
    });
    return { c, rec, home };
  }

  test("no control token -> ErrNoControl, zero bytes", async () => {
    const { c, rec } = rig();
    const err = await caught(
      c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
    );
    expect(isSentinel(err, ErrNoControl)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  test("turn in flight -> ErrTurnInFlight, zero bytes", async () => {
    const { c, rec } = rig();
    const release = await c.acquireControl(Context.background());
    c.currentTurn = {
      id: "t1",
      sessionID: "s1",
      role: "assistant",
      state: "pending",
      text: "",
      reason: "",
      startedAt: new Date(),
      completedAt: new Date(0),
      httpCode: 0,
      retryAfter: 0,
    };
    try {
      const err = await caught(
        c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrTurnInFlight)).toBe(true);
      expect(rec.data.length).toBe(0);
    } finally {
      release();
    }
  });

  test("input pending -> ErrInputPending, zero bytes", async () => {
    const { c, rec } = rig();
    const release = await c.acquireControl(Context.background());
    c.handleInputRequested(trustRequest());
    try {
      const err = await caught(
        c.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrInputPending)).toBe(true);
      expect(rec.data.length).toBe(0);
    } finally {
      release();
    }
  });
});

// ── Part B: the sequence, over the real onScreen()/DetectInput() pipeline ───

interface DriverRig {
  conv: Conversation;
  screen: Screen;
  rec: KeyRecorder;
  home: string;
  close: () => Promise<void>;
}

/**
 * Wires a Conversation to a SYNTHETIC Screen through the real
 * turns.Watch(null, screen, adapter) pipeline — the same onScreen()-driven
 * InputRequested/InputResolved path Open() wires, without a PTY subprocess.
 * `sink` is called with every byte setCodexPermissionPreset writes and the
 * screen to paint the next frame onto (fire-and-forget, mirroring
 * set_permission_mode.test.ts's newCodexRing).
 */
function newDriverRig(
  sink: (bytes: Uint8Array, screen: Screen) => void,
  convOpts: Record<string, unknown> = {},
): DriverRig {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const screen = newScreen(120, 40);
  const adapter = codex.New();
  adapter.bindLaunchEnv([`CODEX_HOME=${home}`], "");
  const watcher = Watch(null, screen, adapter);
  const rec = new KeyRecorder();
  const store = newMemStore();
  const session: Session = {
    id: "sess-1",
    harness: "codex",
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  };
  void store.createSession(session);
  const conv = new Conversation({
    opts: {
      harness: "codex",
      cols: 120,
      rows: 40,
      allowCodexPermissionsWrite: home,
      primeBound: 400,
      permissionSettle: 200,
      ...convOpts,
    },
    screen,
    adapter,
    watcher,
    store,
    session,
    eventCh: new EventBus(8),
    writeStdin: (p) => {
      rec.write(p);
      sink(p, screen);
    },
  });
  conv.startPumps();
  return {
    conv,
    screen,
    rec,
    home,
    close: async () => {
      await conv.close(Context.background());
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Paints the ready composer and takes the control token, as a caller would. */
async function armed(r: DriverRig): Promise<() => void> {
  await r.screen.write(idleText);
  return r.conv.acquireControl(Context.background());
}

const openBurst = dec.decode(codex.New().permissionsDialogKeys());
const backoutBytes = dec.decode(codex.New().dialogBackoutKeys());
const composerClearBytes = dec.decode(codex.New().composerClearKeys());
const statusBurst = dec.decode(codex.New().primeSessionIDKeys());

describe("setCodexPermissionPreset: happy path (commit)", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("selects approve-for-me by alias, commits, and returns the verified reading", async () => {
    const dialogText = frameText((b) => b.CodexPermissionsDialog(0, 1));
    let openSeen = false;
    let committed = false;
    const r = newDriverRig((p, screen) => {
      const s = dec.decode(p);
      if (s === openBurst && !openSeen) {
        openSeen = true;
        void screen.write(dialogText);
        return;
      }
      if (/^[0-9]\r$/.test(s) && !committed) {
        committed = true;
        void screen.write(idleText);
        return;
      }
      if (s === statusBurst) {
        void screen.write(
          frameText((b) =>
            b.CodexStatus(0, "Default", "Workspace (Approve for me)"),
          ),
        );
      }
    });
    rigs.push(r);
    const release = await armed(r);
    try {
      const got = await r.conv.setCodexPermissionPreset(
        Context.background(),
        "approve-for-me",
      );
      expect(got.raw).toBe("Workspace (Approve for me)");
      expect(got.source).toBe("status");
      // Exactly one open burst and one digit+CR commit — no backout, no
      // second /permissions write. A lone ESC (not part of a CSI sequence)
      // would only appear from a backout write.
      const text = dec.decode(r.rec.data);
      expect(text.split(openBurst).length - 1).toBe(1);
      expect(/\x1b(?!\[)/.test(text)).toBe(false);
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: no-op (already current)", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  // Mirrors test/corpus/codex/permissions-approve-current: "Approve for me"
  // is ALREADY the current preset (current=2), so no commit bytes should
  // reach the wire — only the open burst and the ESC backout.
  test("target already current -> ESC backout, NO commit bytes, still returns a verified reading", async () => {
    const dialogText = frameText((b) => b.CodexPermissionsDialog(0, 2));
    let openSeen = false;
    let backoutSeen = false;
    const r = newDriverRig((p, screen) => {
      const s = dec.decode(p);
      if (s === openBurst && !openSeen) {
        openSeen = true;
        void screen.write(dialogText);
        return;
      }
      if (s === backoutBytes && !backoutSeen) {
        backoutSeen = true;
        void screen.write(idleText);
        return;
      }
      if (s === statusBurst) {
        void screen.write(
          frameText((b) =>
            b.CodexStatus(0, "Default", "Workspace (Approve for me)"),
          ),
        );
      }
    });
    rigs.push(r);
    const release = await armed(r);
    try {
      const before = r.rec.data.length;
      const got = await r.conv.setCodexPermissionPreset(
        Context.background(),
        "approve-for-me",
      );
      expect(got.raw).toBe("Workspace (Approve for me)");
      expect(got.source).toBe("status");
      const written = dec.decode(r.rec.data.slice(before));
      // No digit+CR commit anywhere in the bytes written by THIS call.
      expect(/[0-9]\r/.test(written)).toBe(false);
      expect(written).toContain(backoutBytes);
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: feature-flag-off dialog", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("no Approve-for-me row -> backout, ErrPermissionPresetUnavailable (never ErrUnknownOption), conversation not wedged", async () => {
    const dialogText = frameText((b) => b.CodexPermissionsDialogFlagOff(0));
    let openSeen = false;
    const r = newDriverRig((p, screen) => {
      const s = dec.decode(p);
      if (s === openBurst && !openSeen) {
        openSeen = true;
        void screen.write(dialogText);
        return;
      }
      if (s === backoutBytes) {
        void screen.write(idleText);
      }
    });
    rigs.push(r);
    const release = await armed(r);
    try {
      const err = await caught(
        r.conv.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrPermissionPresetUnavailable)).toBe(true);
      expect(String(err)).toContain("approve-for-me");
      expect(dec.decode(r.rec.data)).toContain(backoutBytes);

      // The conversation must not be wedged: a normal send() still works.
      await r.screen.write(idleText);
      const id = await r.conv.send(Context.background(), "hello");
      expect(id).not.toBe("");
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: deadline (dialog never opens)", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("no response to the open burst -> backout written, ErrPermissionPresetUnavailable, no second /permissions write", async () => {
    let opens = 0;
    const r = newDriverRig(
      (p) => {
        const s = dec.decode(p);
        if (s === openBurst) opens++;
        // No response painted at all: the dialog never opens.
      },
      { primeBound: 150, permissionSettle: 100 },
    );
    rigs.push(r);
    const release = await armed(r);
    try {
      const err = await caught(
        r.conv.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrPermissionPresetUnavailable)).toBe(true);
      expect(opens).toBe(1);
      expect(dec.decode(r.rec.data)).toContain(backoutBytes);
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: swallowed-write (composer ate the command)", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("composer holds literal /permissions text -> composer-clear written, next send() is clean", async () => {
    const dirtyText = frameText((b) => b.CodexDirtyComposer(0, "/permissions"));
    const cleanText = frameText((b) => b.CodexDirtyComposer(0, ""));
    let openSeen = false;
    let cleared = false;
    const r = newDriverRig(
      (p, screen) => {
        const s = dec.decode(p);
        if (s === openBurst && !openSeen) {
          openSeen = true;
          // The write lands in the composer as literal text instead of
          // opening the dialog — codexPromptRE still matches this row, so
          // readyForInput("codex", …) reports true even though nothing
          // opened.
          void screen.write(dirtyText);
          return;
        }
        if (s === backoutBytes) {
          // ESC does not clear a composer holding literal text.
          return;
        }
        if (s === composerClearBytes && !cleared) {
          cleared = true;
          void screen.write(cleanText);
        }
      },
      { primeBound: 200, permissionSettle: 150, echoBound: 80 },
    );
    rigs.push(r);
    const release = await armed(r);
    try {
      const err = await caught(
        r.conv.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrPermissionPresetUnavailable)).toBe(true);
      expect(dec.decode(r.rec.data)).toContain(composerClearBytes);
      // The final screen's composer is empty — the same predicate the
      // driver's own dialogSettled() checks.
      expect(codex.New().composerHasText(r.screen.snapshot())).toBe(false);

      // The caller's next send() transmits its prompt clean — no leftover
      // `/permissions` prefix.
      await r.screen.write(idleText);
      const beforeSend = r.rec.data.length;
      const id = await r.conv.send(Context.background(), "hello world");
      expect(id).not.toBe("");
      const sentText = dec.decode(r.rec.data.slice(beforeSend));
      expect(sentText.startsWith("hello world")).toBe(true);
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: raced by another resolver", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("onInputRequest answers permissions_prompt first -> ErrCodexPermissionsRaced, no second answer()", async () => {
    const dialogText = frameText((b) => b.CodexPermissionsDialog(0, 1));
    let openSeen = false;
    const r = newDriverRig(
      (p, screen) => {
        const s = dec.decode(p);
        if (s === openBurst && !openSeen) {
          openSeen = true;
          void screen.write(dialogText);
          return;
        }
        if (s === backoutBytes) {
          void screen.write(idleText);
        }
      },
      {
        onInputRequest: (req: { kind: string }) => {
          if (req.kind === codex.KindPermissions) {
            return [{ optionID: "3" }, true] as [unknown, boolean];
          }
          return [{}, false] as [unknown, boolean];
        },
      },
    );
    rigs.push(r);
    const release = await armed(r);
    try {
      const before = r.rec.data.length;
      const err = await caught(
        r.conv.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrCodexPermissionsRaced)).toBe(true);
      const written = dec.decode(r.rec.data.slice(before));
      // The handler's own answer keys ("3\r") went out exactly once — no
      // second answer() raced against it.
      expect((written.match(/3\r/g) ?? []).length).toBe(1);
    } finally {
      release();
    }
  });
});

describe("setCodexPermissionPreset: slash-refusal mid-turn", () => {
  const rigs: DriverRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close();
  });

  test("codex refuses /permissions while a task is in progress -> ErrTurnInFlight, backed out", async () => {
    const refusedText = frameText((b) =>
      b.Raw(0, "■ '/permissions' is disabled while a task is in progress."),
    );
    let openSeen = false;
    const r = newDriverRig((p, screen) => {
      const s = dec.decode(p);
      if (s === openBurst && !openSeen) {
        openSeen = true;
        void screen.write(refusedText);
        return;
      }
      if (s === backoutBytes) {
        void screen.write(idleText);
      }
    });
    rigs.push(r);
    const release = await armed(r);
    try {
      const err = await caught(
        r.conv.setCodexPermissionPreset(Context.background(), "approve-for-me"),
      );
      expect(isSentinel(err, ErrTurnInFlight)).toBe(true);
      expect(dec.decode(r.rec.data)).toContain(backoutBytes);
    } finally {
      release();
    }
  });
});

// ── InputPolicy.default inertness ────────────────────────────────────────────

// This is deliberately independent of setCodexPermissionPreset — it pins the
// STRUCTURAL guarantee the driver's docstring relies on: resolvePolicy falls
// back to `{ kind: p.default }` whenever byKind has no entry for this kind, so
// a bare `default` DOES reach a real permissions_prompt handleInputRequested()
// call — but it can never ACT on it. findOption(req, "") returns null (empty
// optionID), and findOptionByAlias(req, "deny") finds nothing because the
// codex preset-alias rule never emits "proceed"/"deny". Without this test a
// future alias change could silently commit a global write through a policy
// that never named the kind.
describe("InputPolicy.default is inert against a real permissions_prompt", () => {
  const enc = new TextEncoder();
  const permissionsRequest = () => ({
    id: "perm-1",
    kind: codex.KindPermissions,
    prompt: "Update Model Permissions",
    options: [
      {
        id: "1",
        alias: "ask-for-approval",
        label: "Ask for approval (current)",
        keys: enc.encode("1\r"),
        highlighted: true,
      },
      {
        id: "2",
        alias: "approve-for-me",
        label: "Approve for me",
        keys: enc.encode("2\r"),
      },
      {
        id: "3",
        alias: "full-access",
        label: "Full Access",
        keys: enc.encode("3\r"),
      },
    ],
  });

  for (const def of ["deny", "answer"] as const) {
    test(`inputPolicy: { default: "${def}" } -> zero bytes written, the request surfaces`, () => {
      const rec = new KeyRecorder();
      const c = newTestConv(
        { harness: "codex", inputPolicy: { default: def } },
        rec,
      );
      c.handleInputRequested(permissionsRequest());
      expect(rec.data.length).toBe(0);
      expect(c.inputSurfaced).toBe(true);
      expect(c.currentInput?.kind).toBe(codex.KindPermissions);
    });
  }
});

// ── corpus fixtures ──────────────────────────────────────────────────────────

describe("setCodexPermissionPreset: corpus fixtures", () => {
  test("permissions-dialog: approve-for-me resolves by alias to row 2", async () => {
    const bytes = corpusBytes("codex", "permissions-dialog");
    expect(
      bytes,
      "corpus recording codex/permissions-dialog is missing",
    ).not.toBeNull();
    const scr = newScreen(120, 40);
    await scr.write(bytes!);
    const text = scr.snapshot().text;
    const req = codex.DetectInput(text);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindPermissions);
    const target = req!.options!.find((o) => o.alias === "approve-for-me");
    expect(target?.label).toBe("Approve for me");
    expect(dec.decode(target!.keys)).toBe("2\r");
  });

  // Companion to the above: the "already current" shape, which the no-op
  // test above paints via the Builder's byte-identical reconstruction of this
  // exact fixture (CodexPermissionsDialog(0, 2) — see its docstring in
  // fakeharness.ts).
  test("permissions-approve-current: Approve for me is already current", async () => {
    const bytes = corpusBytes("codex", "permissions-approve-current");
    expect(
      bytes,
      "corpus recording codex/permissions-approve-current is missing",
    ).not.toBeNull();
    const scr = newScreen(120, 40);
    await scr.write(bytes!);
    const text = scr.snapshot().text;
    const req = codex.DetectInput(text);
    expect(req).not.toBeNull();
    const target = req!.options!.find((o) => o.alias === "approve-for-me");
    expect(target?.label).toBe("Approve for me (current)");
  });
});
