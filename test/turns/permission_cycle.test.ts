// Contract test for the turns.PermissionModeCycler optional capability.
//
// Two halves, both load-bearing:
//
//  1. The two adapters that implement it return EXACTLY the bytes captured live
//     (test/corpus/{claude-code,codex}/permission-mode-cycle). Pinning the bytes
//     here is what makes a silent re-encoding a test failure rather than a
//     mid-session mode switch that quietly does nothing.
//
//  2. opencode, pi, and a bare GenericAdapter must NOT expose the method. All
//     four harness adapters extend GenericAdapter, so an implementation added to
//     the shared base class would silently hand the capability to every harness
//     and make the downstream ErrPermissionModeUnsupported branch unreachable.
//     The chat-side probe is a runtime `typeof … === "function"` check (it casts
//     the adapter to Record<string, unknown> and never consults AdapterDeps), so
//     this assertion is the only guard that the capability stayed narrow.

import { describe, expect, test } from "vitest";
import * as generic from "../../src/turns/generic.ts";
import * as claudecode from "../../src/turns/harness/claudecode.ts";
import * as codex from "../../src/turns/harness/codex.ts";
import * as opencode from "../../src/turns/harness/opencode.ts";
import * as pi from "../../src/turns/harness/pi.ts";

// The live-captured Shift+Tab press: legacy CSI Z (back-tab). Both harnesses
// also accept the kitty encoding "\x1b[9;2u" (measured), but CSI Z is what the
// adapters pin — see the fixture notes for the full capture.
const shiftTab = new TextEncoder().encode("\x1b[Z");

/** Runtime probe mirroring the chat layer's optional-capability check. */
function cycler(adapter: object): (() => Uint8Array) | null {
  const fn = (adapter as Record<string, unknown>).permissionCycleKeys;
  return typeof fn === "function"
    ? (fn as () => Uint8Array).bind(adapter)
    : null;
}

describe("turns.PermissionModeCycler", () => {
  test("ClaudeCodeAdapter returns the pinned Shift+Tab bytes", () => {
    const adapter = claudecode.New();
    const fn = cycler(adapter);
    expect(fn).not.toBeNull();
    expect(fn!()).toEqual(shiftTab);
    // Also reachable as a plain method (the interface, not just the probe).
    expect(adapter.permissionCycleKeys()).toEqual(shiftTab);
  });

  test("CodexAdapter returns the pinned Shift+Tab bytes", () => {
    const adapter = codex.New();
    const fn = cycler(adapter);
    expect(fn).not.toBeNull();
    expect(fn!()).toEqual(shiftTab);
    expect(adapter.permissionCycleKeys()).toEqual(shiftTab);
  });

  test("the two implementors agree on the encoding", () => {
    expect(claudecode.New().permissionCycleKeys()).toEqual(
      codex.New().permissionCycleKeys(),
    );
  });

  test("the capability is NOT on the shared GenericAdapter base", () => {
    // The load-bearing assertion: opencode/pi/generic all extend GenericAdapter,
    // so a base-class implementation would light all three up at once.
    for (const [name, adapter] of [
      ["generic", generic.New()],
      ["opencode", opencode.New()],
      ["pi", pi.New()],
    ] as const) {
      expect(
        typeof (adapter as unknown as Record<string, unknown>)
          .permissionCycleKeys,
        `${name} must not expose permissionCycleKeys`,
      ).not.toBe("function");
      expect(cycler(adapter), `${name} probe must miss`).toBeNull();
    }
  });
});
