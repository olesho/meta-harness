// Gated LIVE conformance suite — the TS analogue of Go's
// pkg/harness/conformance_test.go. It runs against the REAL installed harness
// binaries and is therefore OPT-IN: skipped by default so CI without the
// binaries stays green. Enable it with:
//
//   CONFORMANCE=1 bun test test/conformance.test.ts
//
// It has two independent halves, one per conformance fact:
//
//   1. VERSION-DRIFT. For each adapter declared in versions.json, detect the
//      installed binary and its version (src/discovery), then assert that the
//      detected version matches the pinned/verified fact (versions.ts Entry).
//      This is PRECISELY planAcquisition's fact 3 (capability-by-version) — the
//      third of the three facts its Stream gate depends on. When the installed
//      version diverges from the pin the test FAILS with a clear drift report
//      rather than silently passing, so the version predicate cannot drift out
//      from under the acquisition plan unnoticed.
//
//   2. SENTINEL ROUND-TRIP. For each installed adapter, drive the REACHABLE
//      acquisition path end-to-end through the acquisition-attached chat seam
//      (Open + onAcquisitionEvent + StreamTap) with a sentinel prompt. Because
//      all four current adapters resolve to Hooks/Off (no adapter marks itself
//      StreamInterleaved, and Hooks delivery is not viable in A1), the LATCHED
//      mode is never Stream — the round-trip exercises the Hooks/Off path and
//      asserts the acquisition subsystem behaves correctly for that mode:
//        - the harness session id is captured exactly once (no double-write),
//        - the latched mode is Hooks or Off — never Stream — for real adapters,
//        - every delivered acquisition event obeys admitParent for that mode.
//      Live Stream against real binaries is intentionally NOT exercised here;
//      Stream's only A1 exercise is the fake-adapter test in stream_acquisition.
//
// Both halves are cleanly SKIPPED (not failed) when CONFORMANCE is unset or the
// binary is absent.

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../src/internal/async/index.ts";
import {
  EventTurn,
  Open,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
  newMemStore,
  resolveAdapter,
  type Conversation,
  type Turn,
} from "../src/chat/index.ts";
import { AutoAcceptTrust } from "../src/oneshot/index.ts";
import { lookup, type Info } from "../src/discovery/index.ts";
import { all as allVersions } from "../src/versions/index.ts";
import {
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
  describeAcquisitionMode,
  type AcquisitionMode,
} from "../src/turns/index.ts";
import { SourceLive, type EventEnvelope } from "../src/transcript/index.ts";
import {
  planAcquisition,
  resolveProfile,
} from "../src/acquisition/internal/planAcquisition.ts";
import { admitParent } from "../src/acquisition/internal/filter.ts";

// ── Gate ────────────────────────────────────────────────────────────────────

const CONFORMANCE = process.env.CONFORMANCE === "1";

// The canonical harnesses whose adapters resolveAdapter knows about, in a stable
// order. Every entry in versions.json is one of these.
const HARNESSES = ["codex", "claude-code", "opencode", "pi"] as const;

// Detect each installed binary ONCE at load time. discovery.lookup runs the
// registered version probe, so `info.detectedVersion` is the live fact.
const infos: Record<string, Info> = {};
for (const name of HARNESSES) {
  infos[name] = lookup(name);
}

// ── Sentinel prompt ───────────────────────────────────────────────────────────

// A prompt whose reply is trivially checkable and cannot be confused with the
// echoed prompt itself.
const PROMPT = "Reply with exactly the single word: pomegranate";

const TEST_TIMEOUT = 240_000;
const CTX_DEADLINE = TEST_TIMEOUT - 15_000;

/** Drains conversation events until the assistant turn reaches a terminal state. */
async function waitTerminal(ctx: Context, conv: Conversation): Promise<Turn> {
  const bus = conv.events();
  for (;;) {
    const outcome = await Promise.race([
      bus.receive(),
      ctx.done().then(() => "cancel" as const),
    ]);
    if (outcome === "cancel")
      throw ctx.err() ?? new Error("conformance: context done");
    const { value, ok } = outcome;
    if (!ok)
      throw new Error(
        "conformance: event channel closed before a terminal turn",
      );
    const ev = value!;
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete ||
        ev.turn.state === TurnStateErrored)
    ) {
      return ev.turn;
    }
  }
}

/**
 * expectedLatchedMode mirrors conversation.ts's acquisition plan for a run:
 * resolveProfile over the DETECTED discovery info + the real adapter, then
 * planAcquisition with a sink present and Hooks delivery not viable (the A1
 * facts). This is the mode the live seam will latch — computed here so the
 * round-trip can assert it is never Stream for a real adapter.
 */
function expectedLatchedMode(info: Info): AcquisitionMode {
  const adapter = resolveAdapter(info.harness);
  const profile = resolveProfile({
    info: {
      harness: info.harness,
      installed: true,
      detectedVersion: info.detectedVersion,
      pinnedVersion: info.pinnedVersion,
    },
    adapter,
  });
  return planAcquisition(AcquisitionModeStream, {
    profile,
    haveSink: true,
    // Hooks side-channel delivery is not viable in A1 (mirrors conversation.ts).
    hooksViable: false,
  });
}

// ── Half 1: version-drift ─────────────────────────────────────────────────────

describe("conformance: version-drift (CONFORMANCE=1)", () => {
  for (const name of HARNESSES) {
    const info = infos[name];
    const entry = allVersions().get(name);
    const pinned = entry?.pinned ?? "";

    // Skip when the suite is not opted-in OR the binary is not installed OR the
    // harness carries no pin to drift against (an unpinned harness like opencode
    // has no version fact to enforce). None of these are failures.
    const skip = !CONFORMANCE || !info.installed || pinned === "";

    test.skipIf(skip)(
      `${name}: installed version matches pinned/verified fact`,
      () => {
        // A probe that ran but failed is a hard error: we cannot assert the
        // version fact, and a silent pass would defeat the guard.
        expect(
          info.versionProbeError,
          `${name}: version probe failed: ${info.versionProbeError}`,
        ).toBe("");
        expect(
          info.detectedVersion,
          `${name}: no version detected from the installed binary`,
        ).not.toBe("");

        // The load-bearing assertion: the installed binary's version equals the
        // pinned/verified version. A divergence means the capability-by-version
        // fact planAcquisition's Stream gate relies on has DRIFTED — surface it
        // loudly (fail) instead of passing silently.
        expect(
          info.detectedVersion,
          `${name}: VERSION DRIFT — installed ${info.detectedVersion} != pinned ${pinned} ` +
            `(verified ${entry?.verifiedAt || "?"}). Re-verify the adapter against the ` +
            `installed upstream and update versions.json, or reinstall the pinned version.`,
        ).toBe(pinned);
        // discovery's own drift flag must agree with the raw comparison.
        expect(info.versionMatchesPin).toBe(true);
      },
    );
  }
});

// ── Half 2: sentinel round-trip ────────────────────────────────────────────────

describe("conformance: sentinel round-trip (CONFORMANCE=1)", () => {
  for (const name of HARNESSES) {
    const info = infos[name];
    const skip = !CONFORMANCE || !info.installed;

    test.skipIf(skip)(
      `${name}: reachable acquisition path — id captured once, latched mode is Hooks/Off, admitParent honored`,
      async () => {
        // Real adapters never satisfy the Stream gate (none are interleaved),
        // and Hooks delivery is not viable in A1 — so the latched mode is Off (or
        // Hooks if a future adapter makes it viable), NEVER Stream. Assert that
        // BEFORE launching, so a drift in the gate predicates is caught even if
        // the live launch is flaky.
        const latched = expectedLatchedMode(info);
        expect(
          latched,
          `${name}: latched acquisition mode is ${describeAcquisitionMode(latched)}, ` +
            `expected a reachable mode (hooks/off) — Stream must be unreachable for real adapters`,
        ).not.toBe(AcquisitionModeStream);
        expect([AcquisitionModeHooks, AcquisitionModeOff]).toContain(latched);

        const dir = mkdtempSync(join(tmpdir(), `conformance-${name}-`));
        const store = newMemStore();
        const events: EventEnvelope[] = [];
        const { ctx, cancel } = Context.withDeadline(
          Context.background(),
          CTX_DEADLINE,
        );

        let conv: Conversation | undefined;
        try {
          conv = await Open(ctx, {
            harness: info.harness,
            binaryPath: info.path,
            workingDir: dir,
            store,
            inputPolicy: AutoAcceptTrust,
            // Attach the acquisition subsystem: a sink makes the plan pick the
            // reachable mode and routes any admitted events here.
            acquisitionMode: AcquisitionModeStream,
            onAcquisitionEvent: (env) => events.push(env),
          });

          // Drive the sentinel prompt through the same control/send seam chat
          // exposes to callers.
          const release = await conv.acquireControl(ctx);
          try {
            await conv.send(ctx, PROMPT);
          } finally {
            release();
          }

          const turn = await waitTerminal(ctx, conv);
          expect(
            turn.state,
            `${name}: turn errored: ${turn.reason ?? ""}`,
          ).toBe(TurnStateComplete);
          expect(turn.text.trim(), `${name}: empty assistant reply`).not.toBe(
            "",
          );

          // Session id captured EXACTLY once: the store record carries a stable,
          // non-empty harness session id, and a second read is byte-identical —
          // no double-write from the acquisition tap (StreamTap only READS it).
          const first = await store.getSession(conv.sessionID());
          expect(
            first.harnessSessionID,
            `${name}: harness session id was not captured`,
          ).not.toBe("");
          const second = await store.getSession(conv.sessionID());
          expect(second.harnessSessionID).toBe(first.harnessSessionID);
          // The live conversation view agrees with the persisted record.
          expect(conv.session.harnessSessionID).toBe(first.harnessSessionID);

          // Every delivered acquisition event must have been admissible under the
          // central authority filter for the LATCHED mode. For Off no event is
          // ever admitted (StreamTap goes inert), so this also asserts the sink
          // stayed silent; for Hooks it asserts the source/kind authority held.
          for (const env of events) {
            const source = (env.event.source ?? SourceLive) as "live" | "file";
            const isSubagent = (env.parentSessionID ?? "") !== "";
            expect(
              admitParent(latched, source, env.event.type ?? "", isSubagent),
              `${name}: event kind=${env.event.type} source=${source} was delivered but ` +
                `admitParent(${describeAcquisitionMode(latched)}) rejects it`,
            ).toBe(true);
            // Delivered events carry the run identity and the captured id.
            expect(env.runID).toBe(conv.sessionID());
            expect(env.harness).toBe(info.harness);
          }
          // In the Off latched mode the acquisition sink must stay silent — the
          // filter admits nothing, so no double-record leaks through.
          if (latched === AcquisitionModeOff) {
            expect(
              events.length,
              `${name}: Off mode delivered ${events.length} acquisition events; expected none`,
            ).toBe(0);
          }

          await conv.quit(ctx).catch(() => {});
        } finally {
          cancel();
          if (conv) {
            const { ctx: closeCtx } = Context.withDeadline(
              Context.background(),
              3000,
            );
            await conv.close(closeCtx).catch(() => {});
          }
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT,
    );
  }
});
