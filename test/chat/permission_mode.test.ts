// permissionMode plumbing at the chat seam: the launch-arg forward into the
// wrapper Config, and the claude-only `bypass` bypass_acceptance default policy
// that keeps an unattended Open from wedging on the "Bypass Permissions mode"
// dialog.
//
// PUPPET-526 split that screen's kind out of `trust_prompt`. The assertions
// below were retargeted at `byKind.bypass_acceptance` accordingly: leaving the
// gate on `trust_prompt` would have made the default INERT (the detector no
// longer emits that kind for this screen), so a bypass launch with no caller
// policy would wedge on the modal.

import { afterEach, describe, expect, test } from "vitest";
import { launchInputPolicy } from "../../src/chat/conversation.ts";
import {
  DispositionAnswer,
  DispositionDeny,
  type InputPolicy,
} from "../../src/chat/types.ts";
import { Context } from "../../src/internal/async/index.ts";
import type { Conversation } from "../../src/chat/index.ts";
import {
  KeyRecorder,
  bypassRequest,
  newTestConv,
  trustRequest,
} from "./helpers.ts";
import { New, argvOutPath, openFake, readArgv } from "./fakeharness.ts";

const open = new Set<Conversation>();

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/**
 * Answers the shared bypass_acceptance fixture under `policy` and returns the
 * keys written. That fixture's menu is 1. "No, exit" / 2. "Yes, I accept", so
 * "proceed" writes "2\r" and a deny writes "1\r" — the reverse of the
 * folder-trust dialog's numbering.
 */
function keysForPolicy(policy: InputPolicy | undefined): string {
  const rec = new KeyRecorder();
  const c = newTestConv({ harness: "claude-code", inputPolicy: policy }, rec);
  c.handleInputRequested(bypassRequest());
  return rec.text();
}

/** As keysForPolicy, but against the folder-trust fixture (1. Yes / 2. No). */
function trustKeysForPolicy(policy: InputPolicy | undefined): string {
  const rec = new KeyRecorder();
  const c = newTestConv({ harness: "claude-code", inputPolicy: policy }, rec);
  c.handleInputRequested(trustRequest());
  return rec.text();
}

describe("launchInputPolicy — claude bypass acceptance default", () => {
  test("claude-code + bypass with no inputPolicy answers bypass_acceptance with proceed", () => {
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
    });
    expect(policy?.byKind?.bypass_acceptance).toEqual({
      kind: DispositionAnswer,
      optionID: "proceed",
    });
    // The folder-trust dialog is NOT covered: the default targets one screen.
    expect(policy?.byKind?.trust_prompt).toBeUndefined();
    // "proceed" resolves through findOption's ALIAS match — claude's menu ids
    // are the menu numbers, and on THIS screen "Yes, I accept" is option 2.
    expect(keysForPolicy(policy)).toBe("2\r");
  });

  test("the claude-native bypassPermissions spelling installs it too", () => {
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypassPermissions",
    });
    expect(keysForPolicy(policy)).toBe("2\r");
  });

  test("the bare `claude` harness alias is gated in as well", () => {
    const policy = launchInputPolicy({
      harness: "claude",
      permissionMode: "bypass",
    });
    expect(policy?.byKind?.bypass_acceptance?.optionID).toBe("proceed");
  });

  test("a caller byKind.bypass_acceptance entry is NOT overwritten", () => {
    // Rule 1: the caller named the kind explicitly, so the policy is returned
    // by identity — the post-split spelling of "the caller always wins".
    const caller: InputPolicy = {
      byKind: { bypass_acceptance: { kind: DispositionDeny } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy).toBe(caller);
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("a caller byKind.trust_prompt entry is inherited, not overridden", () => {
    // Rule 2, the PUPPET-526 compatibility shim. BEFORE the split this caller's
    // trust_prompt entry stood the default down and then answered the
    // acceptance screen itself — a `deny` written specifically to refuse a
    // bypass launch. Moving the gate naively would have flipped that to
    // "proceed", silently, for a policy whose entire point is refusal. So the
    // disposition is copied onto bypass_acceptance verbatim.
    //
    // Note this is now a NEW object (the pre-split test asserted
    // `expect(policy).toBe(caller)`); assert BEHAVIOUR — it still denies.
    const caller: InputPolicy = {
      byKind: { trust_prompt: { kind: DispositionDeny } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy?.byKind?.bypass_acceptance).toEqual({
      kind: DispositionDeny,
    });
    expect(keysForPolicy(policy)).toBe("1\r");
    // …and the caller's own trust_prompt entry is preserved untouched.
    expect(policy?.byKind?.trust_prompt).toEqual({ kind: DispositionDeny });
    expect(trustKeysForPolicy(policy)).toBe("2\r");
  });

  test("an inherited trust_prompt ANSWER is copied verbatim, alias and all", () => {
    // The shim copies the disposition unchanged rather than normalising it, so
    // a caller who pinned a menu NUMBER before the split still gets that exact
    // answer on the screen the entry was written for.
    const caller: InputPolicy = {
      byKind: { trust_prompt: { kind: DispositionAnswer, optionID: "1" } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy?.byKind?.bypass_acceptance).toEqual({
      kind: DispositionAnswer,
      optionID: "1",
    });
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("a caller bare `default` disposition is NOT overwritten", () => {
    // Rule 1 again: resolvePolicy returns non-null for a bare default on ANY
    // kind, so the default policy stands down and the caller is returned by
    // identity — unchanged by the split.
    const caller: InputPolicy = { default: DispositionDeny };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy).toBe(caller);
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("a caller policy for OTHER kinds still gets the bypass default", () => {
    const caller: InputPolicy = {
      byKind: { question: { kind: DispositionDeny } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy?.byKind?.question).toEqual({ kind: DispositionDeny });
    expect(policy?.byKind?.bypass_acceptance?.optionID).toBe("proceed");
  });

  test("codex + bypass installs NO default (the harness gate)", () => {
    expect(
      launchInputPolicy({ harness: "codex", permissionMode: "bypass" }),
    ).toBeUndefined();
    // …and a codex caller policy passes through untouched.
    const caller: InputPolicy = { default: DispositionDeny };
    expect(
      launchInputPolicy({
        harness: "codex",
        permissionMode: "danger-full-access",
        inputPolicy: caller,
      }),
    ).toBe(caller);
  });

  test("a non-bypass rung, and an unset mode, install nothing", () => {
    for (const mode of [undefined, "", "plan", "manual", "ask", "auto"]) {
      expect(
        launchInputPolicy({ harness: "claude-code", permissionMode: mode }),
      ).toBeUndefined();
    }
  });
});

// ── PUPPET-526 separation guard ────────────────────────────────────────────
//
// The capability the split exists to add: ONE policy that says "yes" to folder
// trust and "no" to the skip-all-permissions acceptance screen at the same
// time. While both screens carried kind "trust_prompt" that sentence was
// inexpressible — one map key covered both, so any policy that trusted a folder
// also accepted a bypass launch, silently. Twin of harness-wrapper's
// TestPolicy_CanTrustFolderWithoutAcceptingBypass (PUPPET-507).
describe("a byKind policy can trust a folder without accepting bypass", () => {
  test("trust answers proceed, bypass answers deny, under one policy", () => {
    const policy: InputPolicy = {
      byKind: {
        trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
        bypass_acceptance: { kind: DispositionDeny },
      },
    };

    // Folder trust: 1. "Yes, proceed" / 2. "No, exit" → accepted.
    expect(trustKeysForPolicy(policy)).toBe("1\r");
    // Bypass acceptance: 1. "No, exit" / 2. "Yes, I accept" → refused. If the
    // trust entry were still covering both screens this would be "2\r".
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("a bypass launch auto-answers the acceptance screen end to end", async () => {
    // The regression the PUPPET-526 resolution order exists to prevent. Leaving
    // launchInputPolicy's gate on `trust_prompt` after the split makes the
    // default INERT: the detector now stamps this screen `bypass_acceptance`,
    // nothing answers it, and it parks as a pending input request. Verified
    // both ways — this fails with the gate on the old kind.
    const script = New("claude-code")
      .Idle()
      .BypassPrompt(300)
      .StayAliveUntilStopped()
      .Build();
    const conv = await openFake(script, { permissionMode: "bypass" });
    open.add(conv);
    await new Promise((r) => setTimeout(r, 1500));
    expect(conv.pendingInput()).toBeNull();
  }, 25000);

  test("a bare `default` still covers both kinds", () => {
    // resolvePolicy falls back to `default` for ANY kind, so a bare-default
    // caller is unaffected by the split. Guarded so a future byKind-only lookup
    // cannot regress it.
    const policy: InputPolicy = { default: DispositionDeny };
    expect(trustKeysForPolicy(policy)).toBe("2\r");
    expect(keysForPolicy(policy)).toBe("1\r");
  });
});

describe("permissionMode reaches the wrapper Config", () => {
  test("Open forwards it: `ask` launches claude with --permission-mode acceptEdits", async () => {
    const argvOut = argvOutPath("pm-argv-");
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();

    const conv = await openFake(script, {
      permissionMode: "ask",
      argvOut,
    });
    open.add(conv);

    const argv = await readArgv(argvOut);
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  }, 20000);

  test("an unset permissionMode injects nothing", async () => {
    const argvOut = argvOutPath("pm-argv-");
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();

    const conv = await openFake(script, { argvOut });
    open.add(conv);

    const argv = await readArgv(argvOut);
    expect(argv).not.toContain("--permission-mode");
  }, 20000);
});
