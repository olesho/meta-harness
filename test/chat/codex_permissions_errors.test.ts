// The five sentinels the codex `/permissions` driver (META-HARNESS-103) throws.
//
// This file pins the VOCABULARY only — the driver itself lands separately. What
// matters here is what a caller can rely on before any driver exists: the names
// are reachable from the public `chat` barrel, each carries its own stable code,
// and each survives a wrap() the way the raiser will hand it out.
import { describe, expect, test } from "vitest";
import {
  ErrPermissionsUnsupported,
  ErrCodexPermissionsDisabled,
  ErrCodexHomeNotIsolated,
  ErrCodexPermissionsRaced,
  ErrPermissionPresetUnavailable,
  ErrUnknownOption,
  ErrQuitUnsupported,
} from "../../src/chat/index.ts";
import { isSentinel, wrap } from "../../src/internal/async/index.ts";

// Name → the code frozen into the public surface. A rename on either side is a
// breaking change for callers matching on `.code`, so both are spelled out.
const SENTINELS = [
  [
    "ErrPermissionsUnsupported",
    ErrPermissionsUnsupported,
    "chat/permissions-unsupported",
  ],
  [
    "ErrCodexPermissionsDisabled",
    ErrCodexPermissionsDisabled,
    "chat/codex-permissions-disabled",
  ],
  [
    "ErrCodexHomeNotIsolated",
    ErrCodexHomeNotIsolated,
    "chat/codex-home-not-isolated",
  ],
  [
    "ErrCodexPermissionsRaced",
    ErrCodexPermissionsRaced,
    "chat/codex-permissions-raced",
  ],
  [
    "ErrPermissionPresetUnavailable",
    ErrPermissionPresetUnavailable,
    "chat/permission-preset-unavailable",
  ],
] as const;

describe("codex permissions sentinels", () => {
  test("each is exported from the chat barrel under its stable code", () => {
    for (const [name, sentinel, code] of SENTINELS) {
      expect(sentinel, name).toBeDefined();
      expect(sentinel.code, name).toBe(code);
      expect(sentinel.message.startsWith("chat: "), name).toBe(true);
    }
  });

  test("each gate is separately catchable — no two share a code", () => {
    const codes = new Set(SENTINELS.map(([, s]) => s.code));
    expect(codes.size).toBe(SENTINELS.length);
    // Cross-check against the neighbours they must never collapse into: the
    // static-property gate they are modelled on, and the option-id error that
    // ErrPermissionPresetUnavailable exists to stop the feature-flag case from
    // masquerading as.
    for (const [name, sentinel] of SENTINELS) {
      expect(isSentinel(sentinel, ErrQuitUnsupported), name).toBe(false);
      expect(isSentinel(sentinel, ErrUnknownOption), name).toBe(false);
    }
  });

  test("survives wrap(), the way the preset gate hands it out", () => {
    // ErrPermissionPresetUnavailable is raised through wrap() with the observed
    // rows attached, mirroring how ErrUnknownHarness is raised in conversation.ts.
    const err = wrap(
      'chat: permission preset unavailable: "approve-for-me"; rows: Read Only, Default, Custom permissions',
      ErrPermissionPresetUnavailable,
    );
    expect(isSentinel(err, ErrPermissionPresetUnavailable)).toBe(true);
    expect(isSentinel(err, ErrUnknownOption)).toBe(false);
  });
});
