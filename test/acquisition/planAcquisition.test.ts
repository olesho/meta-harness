// Decision-table tests for planAcquisition — the MH port of harness-wrapper's
// planAcquisition (pkg/harness/run.go). Covers stream/hooks/off outcomes, the
// version-predicate gate (fact 3), the interleave-eligibility condition that
// keeps all four current adapters off Stream (fact 2/(c)), and the runtime
// stream-failure fall-back to Hooks/Off.
//
// Everything is driven with fakes: plain discovery/versions inputs and fake
// adapters — one Stream-eligible interleaved fake to reach the Stream branch,
// plus the real-adapter shapes (StreamParser present but NOT interleaved) that
// land on Hooks/Off.

import { describe, expect, test } from "vitest";
import type { Adapter, Event } from "../../src/turns/index.ts";
import type { Status } from "../../src/turns/wrapper.ts";
import type { Snapshot } from "../../src/screen/index.ts";
import {
  AcquisitionModeAuto,
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
} from "../../src/turns/index.ts";
import {
  planAcquisition,
  probeAdapter,
  replanAfterStreamFailure,
  resolveProfile,
  streamEligible,
  type PlanContext,
  type ResolvedProfile,
} from "../../src/acquisition/internal/planAcquisition.ts";

// ── Fake adapters ───────────────────────────────────────────────────────────

/** Minimal base Adapter — implements only the required surface. */
function baseAdapter(name: string): Adapter {
  return {
    name: () => name,
    onScreen: (_snap: Snapshot): Event[] => [],
    onWrapperStatus: (_status: Status, _reason: string): Event[] => [],
  };
}

/** Options selecting which optional capabilities a fake adapter carries. */
interface FakeCaps {
  streamParser?: boolean;
  sessionResumer?: boolean;
  transcriptReader?: boolean;
  /** undefined ⇒ no StreamInterleaved interface; true/false ⇒ marker value. */
  interleaved?: boolean;
}

function fakeAdapter(name: string, caps: FakeCaps): Adapter {
  const a = baseAdapter(name) as Adapter & Record<string, unknown>;
  if (caps.streamParser) a.parseStreamLine = (_line: string) => [];
  if (caps.sessionResumer) a.resumeArgs = (_id: string) => [];
  if (caps.transcriptReader)
    a.readTranscript = (_id: string, _cwd: string) => [];
  if (caps.interleaved !== undefined)
    a.streamInterleaved = () => caps.interleaved!;
  return a;
}

/**
 * The shape of the four current A1 adapters w.r.t. acquisition: they carry a
 * StreamParser but are NOT interleaved (streamInterleaved() === false), so
 * condition (c) fails and they never reach Stream.
 */
const realShapeAdapter = fakeAdapter("real-a1", {
  streamParser: true,
  sessionResumer: true,
  transcriptReader: true,
  interleaved: false,
});

/** The synthetic Stream-eligible fake: parser + interleaved marker true. */
const interleavedFake = fakeAdapter("interleaved-fake", {
  streamParser: true,
  interleaved: true,
});

// ── Profile builders ────────────────────────────────────────────────────────

function profileFrom(
  adapter: Adapter,
  opts: {
    installed?: boolean;
    harness?: string;
    streamVersionSupported?: boolean;
  } = {},
): ResolvedProfile {
  return resolveProfile({
    info: {
      harness: opts.harness ?? "claude-code",
      installed: opts.installed ?? true,
      detectedVersion: "2.1.201",
      pinnedVersion: "2.1.201",
    },
    adapter,
    // Fact 3 driven directly so the test never depends on versions.json.
    streamVersionPredicate: () => opts.streamVersionSupported ?? true,
  });
}

function ctx(
  profile: ResolvedProfile,
  over: Partial<PlanContext> = {},
): PlanContext {
  return { profile, haveSink: true, hooksViable: true, ...over };
}

// ── probeAdapter ────────────────────────────────────────────────────────────

describe("probeAdapter", () => {
  test("detects optional methods by structural probe", () => {
    const caps = probeAdapter(realShapeAdapter);
    expect(caps.hasStreamParser).toBe(true);
    expect(caps.hasSessionResumer).toBe(true);
    expect(caps.hasTranscriptReader).toBe(true);
    expect(caps.streamInterleaved).toBe(false);
  });

  test("bare adapter has no capabilities", () => {
    const caps = probeAdapter(baseAdapter("bare"));
    expect(caps).toEqual({
      hasStreamParser: false,
      hasSessionResumer: false,
      hasTranscriptReader: false,
      streamInterleaved: false,
    });
  });

  test("streamInterleaved marker is invoked, not just present", () => {
    expect(probeAdapter(interleavedFake).streamInterleaved).toBe(true);
    expect(
      probeAdapter(fakeAdapter("x", { interleaved: false })).streamInterleaved,
    ).toBe(false);
  });
});

// ── resolveProfile (three facts) ────────────────────────────────────────────

describe("resolveProfile", () => {
  test("combines install/version/pin, capabilities, and version predicate", () => {
    const p = profileFrom(interleavedFake, { streamVersionSupported: true });
    expect(p.installed).toBe(true);
    expect(p.version).toBe("2.1.201");
    expect(p.hasPin).toBe(true);
    expect(p.capabilities.hasStreamParser).toBe(true);
    expect(p.streamJSONSupported).toBe(true);
  });

  test("streamJSONSupported is false when not installed, even if predicate is true", () => {
    const p = profileFrom(interleavedFake, {
      installed: false,
      streamVersionSupported: true,
    });
    expect(p.streamJSONSupported).toBe(false);
  });

  test("falls back to pinned version when no detected version", () => {
    const p = resolveProfile({
      info: {
        harness: "codex",
        installed: true,
        detectedVersion: "",
        pinnedVersion: "0.142.5",
      },
      adapter: baseAdapter("codex"),
      streamVersionPredicate: () => false,
    });
    expect(p.version).toBe("0.142.5");
    expect(p.hasPin).toBe(true);
    expect(p.streamJSONSupported).toBe(false);
  });
});

// ── streamEligible gate ─────────────────────────────────────────────────────

describe("streamEligible", () => {
  test("true only when parser + version support + interleaved all hold", () => {
    expect(
      streamEligible(
        profileFrom(interleavedFake, { streamVersionSupported: true }),
      ),
    ).toBe(true);
  });

  test("false when version predicate rejects (fact 3 gate)", () => {
    expect(
      streamEligible(
        profileFrom(interleavedFake, { streamVersionSupported: false }),
      ),
    ).toBe(false);
  });

  test("false for the real A1 shape (not interleaved — condition c)", () => {
    expect(
      streamEligible(
        profileFrom(realShapeAdapter, { streamVersionSupported: true }),
      ),
    ).toBe(false);
  });

  test("false when adapter has no StreamParser", () => {
    const noParser = fakeAdapter("noparser", { interleaved: true });
    expect(
      streamEligible(profileFrom(noParser, { streamVersionSupported: true })),
    ).toBe(false);
  });
});

// ── planAcquisition decision table ──────────────────────────────────────────

describe("planAcquisition", () => {
  test("no sink ⇒ Off regardless of mode", () => {
    const p = profileFrom(interleavedFake, { streamVersionSupported: true });
    for (const mode of [
      AcquisitionModeOff,
      AcquisitionModeStream,
      AcquisitionModeHooks,
    ] as const) {
      expect(planAcquisition(mode, ctx(p, { haveSink: false }))).toBe(
        AcquisitionModeOff,
      );
    }
  });

  test("requested Off ⇒ Off", () => {
    const p = profileFrom(interleavedFake, { streamVersionSupported: true });
    expect(planAcquisition(AcquisitionModeOff, ctx(p))).toBe(
      AcquisitionModeOff,
    );
  });

  describe("requested Stream", () => {
    test("Stream when the synthetic interleaved fake is eligible", () => {
      const p = profileFrom(interleavedFake, { streamVersionSupported: true });
      expect(planAcquisition(AcquisitionModeStream, ctx(p))).toBe(
        AcquisitionModeStream,
      );
    });

    test("version-predicate gate: falls back to Hooks when version unsupported", () => {
      const p = profileFrom(interleavedFake, { streamVersionSupported: false });
      expect(planAcquisition(AcquisitionModeStream, ctx(p))).toBe(
        AcquisitionModeHooks,
      );
    });

    test("real A1 shape is not interleaved ⇒ falls back to Hooks", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      expect(planAcquisition(AcquisitionModeStream, ctx(p))).toBe(
        AcquisitionModeHooks,
      );
    });

    test("falls back to Off when not eligible and hooks not viable", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      expect(
        planAcquisition(AcquisitionModeStream, ctx(p, { hooksViable: false })),
      ).toBe(AcquisitionModeOff);
    });
  });

  describe("requested Hooks", () => {
    test("Hooks when hook delivery is viable", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      expect(planAcquisition(AcquisitionModeHooks, ctx(p))).toBe(
        AcquisitionModeHooks,
      );
    });

    test("degrades to Stream when hooks not viable but adapter is Stream-eligible", () => {
      const p = profileFrom(interleavedFake, { streamVersionSupported: true });
      expect(
        planAcquisition(AcquisitionModeHooks, ctx(p, { hooksViable: false })),
      ).toBe(AcquisitionModeStream);
    });

    test("Off when hooks not viable and not Stream-eligible", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      expect(
        planAcquisition(AcquisitionModeHooks, ctx(p, { hooksViable: false })),
      ).toBe(AcquisitionModeOff);
    });
  });

  // ── requested Auto: the request-only token maps onto the Hooks resolution ──
  // These do NOT re-test the resolution logic (already covered above); they
  // assert only that `auto` resolves to the SAME mode as a requested `hooks`
  // across the decision table, and that `auto` is never itself returned.
  describe("requested Auto (best available channel)", () => {
    test("no sink ⇒ Off (same as Hooks)", () => {
      const p = profileFrom(interleavedFake, { streamVersionSupported: true });
      const c = ctx(p, { haveSink: false });
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        planAcquisition(AcquisitionModeHooks, c),
      );
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(AcquisitionModeOff);
    });

    test("hooks-viable ⇒ Hooks (same as Hooks)", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      const c = ctx(p);
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        planAcquisition(AcquisitionModeHooks, c),
      );
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        AcquisitionModeHooks,
      );
    });

    test("hooks-not-viable + stream-eligible ⇒ Stream (same as Hooks)", () => {
      const p = profileFrom(interleavedFake, { streamVersionSupported: true });
      const c = ctx(p, { hooksViable: false });
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        planAcquisition(AcquisitionModeHooks, c),
      );
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        AcquisitionModeStream,
      );
    });

    test("neither hooks-viable nor stream-eligible ⇒ Off (same as Hooks)", () => {
      const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
      const c = ctx(p, { hooksViable: false });
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(
        planAcquisition(AcquisitionModeHooks, c),
      );
      expect(planAcquisition(AcquisitionModeAuto, c)).toBe(AcquisitionModeOff);
    });

    test("auto is resolved to a concrete mode, never returned verbatim", () => {
      for (const over of [
        {},
        { hooksViable: false },
        { haveSink: false },
      ] as const) {
        const p = profileFrom(interleavedFake, {
          streamVersionSupported: true,
        });
        const resolved = planAcquisition(AcquisitionModeAuto, ctx(p, over));
        expect(resolved).not.toBe(AcquisitionModeAuto);
        expect([
          AcquisitionModeOff,
          AcquisitionModeStream,
          AcquisitionModeHooks,
        ]).toContain(resolved);
      }
    });
  });

  test("all four real A1 adapter shapes land on Hooks (never Stream)", () => {
    // The four adapters share the acquisition shape: StreamParser present, not
    // interleaved. Whatever the requested mode, they cannot reach Stream.
    const p = profileFrom(realShapeAdapter, { streamVersionSupported: true });
    expect(planAcquisition(AcquisitionModeStream, ctx(p))).toBe(
      AcquisitionModeHooks,
    );
    expect(planAcquisition(AcquisitionModeHooks, ctx(p))).toBe(
      AcquisitionModeHooks,
    );
  });
});

// ── runtime stream-failure fall-back ────────────────────────────────────────

describe("replanAfterStreamFailure", () => {
  test("falls back to Hooks when hook delivery is viable", () => {
    const p = profileFrom(interleavedFake, { streamVersionSupported: true });
    expect(replanAfterStreamFailure(ctx(p, { hooksViable: true }))).toBe(
      AcquisitionModeHooks,
    );
  });

  test("falls back to Off when hooks not viable", () => {
    const p = profileFrom(interleavedFake, { streamVersionSupported: true });
    expect(replanAfterStreamFailure(ctx(p, { hooksViable: false }))).toBe(
      AcquisitionModeOff,
    );
  });
});
