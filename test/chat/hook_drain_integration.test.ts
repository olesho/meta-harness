// End-to-end integration of the hook drain THROUGH a real Conversation on the
// in-process fake backend (fakeharness), driving the riskiest seam:
//
//   hook subprocess fires → writes spool → the runtime drains on its OWN
//   hookDrainCh wakeup (NOT gated on the turn watcher) → drainSpool yields
//   SourceHook ParsedEvents → they flow through the dedup consumer to the
//   durable-store sink (onHookEvents).
//
// Provenance (source === SourceHook) is asserted at the store/transcript layer —
// NEVER on a Conversation.events() element, which structurally cannot carry it
// (ConversationEvent has no `source`; turnsFromEvents drops it at the Turn
// boundary). A lifecycle edge surfaced on the chat side is asserted separately
// as a turn-boundary Turn projection, on which `source` is not observable.

import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { New, openFake } from "./fakeharness.ts";
import type { Conversation } from "../../src/chat/index.ts";
import {
  SourceHook,
  type ParsedEvent,
  type Turn as TranscriptTurn,
} from "../../src/transcript/event.ts";
import { marshalParsedEvents } from "../../src/transcript/eventWire.ts";
import { spoolFilePath } from "../../src/hooks/spool.ts";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOOKS_BIN = path.join(root, "dist", "cli", "hooks.js");

const dirs: string[] = [];
const convs: Conversation[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mh-hookconv-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of convs.splice(0)) {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// fireHook runs the OUT-OF-PROCESS meta-harness-hooks bin exactly as a harness
// would: piping the native payload on stdin with the HW_* env set.
function fireHook(
  spoolDir: string,
  sessionID: string,
  cwd: string,
  event: string,
): void {
  if (!existsSync(HOOKS_BIN)) {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  }
  execFileSync(process.execPath, [HOOKS_BIN, "claude-code", event], {
    input: JSON.stringify({ session_id: sessionID, hook_event_name: event }),
    env: {
      ...process.env,
      HW_EVENT_SPOOL: spoolDir,
      HW_HARNESS_SESSION_ID: sessionID,
      HW_HOOK_CWD: cwd,
      HW_HOME: cwd,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("hook drain — integration through a Conversation (fake backend)", () => {
  test("hook subprocess → spool → own-wakeup drain → SourceHook events at the store layer", async () => {
    const configDir = tempDir();
    const routed: ParsedEvent[] = [];
    let resolveGot!: () => void;
    const gotOne = new Promise<void>((r) => (resolveGot = r));

    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {
      workingDir: configDir,
      hooksConfigDir: configDir,
      onHookEvents: (evs) => {
        routed.push(...evs);
        resolveGot();
      },
    });
    convs.push(conv);

    // The drain is active and owns a spool dir under the config dir.
    expect(conv.hookDrain).toBeDefined();
    const spoolDir = conv.hookDrain!.spoolDir();
    expect(existsSync(spoolDir)).toBe(true);
    const sessionID = conv.session.harnessSessionID;
    expect(sessionID).not.toBe("");

    // Fire a real hook subprocess: it writes the spool out of process.
    fireHook(spoolDir, sessionID, configDir, "Stop");
    expect(existsSync(spoolFilePath(spoolDir))).toBe(true);

    // The runtime drains it on ITS OWN wakeup (spool fs-watch raising hookDrainCh,
    // backed by the bounded fallback timer) — no send(), no turn activity.
    await Promise.race([gotOne, delay(4000)]);

    expect(routed.length).toBeGreaterThan(0);
    // Provenance is observable HERE (store layer), and round-trips on the wire.
    for (const pe of routed) expect(pe.event.source).toBe(SourceHook);
    const wire = JSON.parse(marshalParsedEvents(routed)) as {
      event: { source?: string };
    }[];
    for (const w of wire) expect(w.event.source).toBe("hook");
  }, 30_000);

  test("idle drain is NOT gated on the turn watcher yielding a foreign-source event", async () => {
    // No send is ever issued, so the turn watcher never advances past the idle
    // prompt. A hook still drains — proving the drain runs on its own loop.
    const configDir = tempDir();
    let resolveGot!: () => void;
    const gotOne = new Promise<void>((r) => (resolveGot = r));

    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {
      workingDir: configDir,
      hooksConfigDir: configDir,
      // A short fallback so even a missed fs event drains promptly via the timer.
      hookDrainFallbackMs: 100,
      onHookEvents: () => {
        resolveGot();
      },
    });
    convs.push(conv);

    const spoolDir = conv.hookDrain!.spoolDir();
    fireHook(spoolDir, conv.session.harnessSessionID, configDir, "Stop");

    // Must resolve well within the window with NO turn activity at all.
    const won = await Promise.race([
      gotOne.then(() => "drained" as const),
      delay(3000).then(() => "timeout" as const),
    ]);
    expect(won).toBe("drained");
  }, 30_000);

  test("a turn-boundary edge is projected SEPARATELY to a Turn with no observable source", async () => {
    const configDir = tempDir();
    const boundaryTurns: TranscriptTurn[] = [];
    let resolveGot!: () => void;
    const gotOne = new Promise<void>((r) => (resolveGot = r));

    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {
      workingDir: configDir,
      hooksConfigDir: configDir,
      hookDrainFallbackMs: 100,
      onHookEvents: () => {},
      onHookBoundaryTurns: (turns) => {
        boundaryTurns.push(...turns);
        resolveGot();
      },
    });
    convs.push(conv);

    fireHook(
      conv.hookDrain!.spoolDir(),
      conv.session.harnessSessionID,
      configDir,
      "Stop",
    );
    await Promise.race([gotOne, delay(3000)]);

    expect(boundaryTurns.length).toBeGreaterThan(0);
    // The chat-surface projection carries role/text/timestamp only — no `source`.
    for (const t of boundaryTurns)
      expect("source" in (t as object)).toBe(false);
  }, 30_000);

  test("close reaps the spool dir after a final flush drain", async () => {
    const configDir = tempDir();
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {
      workingDir: configDir,
      hooksConfigDir: configDir,
      onHookEvents: () => {},
    });
    const spoolDir = conv.hookDrain!.spoolDir();
    expect(existsSync(spoolDir)).toBe(true);
    await conv.close();
    expect(existsSync(spoolDir)).toBe(false);
  }, 30_000);

  test("without onHookEvents the drain is inert (opt-in, existing runs unchanged)", async () => {
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {});
    convs.push(conv);
    expect(conv.hookDrain).toBeUndefined();
  }, 30_000);
});
