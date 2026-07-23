// permissionMode plumbing at the chat seam: the launch-arg forward into the
// wrapper Config, and the claude-only `bypass` trust_prompt default policy that
// keeps an unattended Open from wedging on the "Bypass Permissions mode" dialog.

import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchInputPolicy } from "../../src/chat/conversation.ts";
import {
  DispositionAnswer,
  DispositionDeny,
  type InputPolicy,
} from "../../src/chat/types.ts";
import { Context } from "../../src/internal/async/index.ts";
import type { Conversation } from "../../src/chat/index.ts";
import { KeyRecorder, newTestConv, trustRequest } from "./helpers.ts";
import { New, openFake } from "./fakeharness.ts";

const open = new Set<Conversation>();

/**
 * The fake dumps its argv from its own `run()`, which can land AFTER Open
 * resolves (claude-code seeds its session id from initSession rather than
 * scraping the screen, so Open does not wait on the child painting anything).
 * Poll rather than read once.
 */
async function readArgv(path: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      if (raw !== "") return JSON.parse(raw) as string[];
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fake harness never dumped its argv to ${path}`);
}

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/** Answers the shared trust_prompt fixture under `policy` and returns the keys written. */
function keysForPolicy(policy: InputPolicy | undefined): string {
  const rec = new KeyRecorder();
  const c = newTestConv({ harness: "claude-code", inputPolicy: policy }, rec);
  c.handleInputRequested(trustRequest());
  return rec.text();
}

describe("launchInputPolicy — claude bypass trust_prompt default", () => {
  test("claude-code + bypass with no inputPolicy answers trust_prompt with proceed", () => {
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
    });
    expect(policy?.byKind?.trust_prompt).toEqual({
      kind: DispositionAnswer,
      optionID: "proceed",
    });
    // "proceed" resolves through findOption's ALIAS match — claude's menu ids
    // are the menu numbers, so the keys written are option 1's.
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("the claude-native bypassPermissions spelling installs it too", () => {
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypassPermissions",
    });
    expect(keysForPolicy(policy)).toBe("1\r");
  });

  test("the bare `claude` harness alias is gated in as well", () => {
    const policy = launchInputPolicy({
      harness: "claude",
      permissionMode: "bypass",
    });
    expect(policy?.byKind?.trust_prompt?.optionID).toBe("proceed");
  });

  test("a caller byKind.trust_prompt entry is NOT overwritten", () => {
    const caller: InputPolicy = {
      byKind: { trust_prompt: { kind: DispositionDeny } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy).toBe(caller);
    expect(keysForPolicy(policy)).toBe("2\r");
  });

  test("a caller bare `default` disposition is NOT overwritten", () => {
    // resolvePolicy returns non-null for a bare default, so the default policy
    // must stand down even though byKind carries no trust_prompt entry.
    const caller: InputPolicy = { default: DispositionDeny };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy).toBe(caller);
    expect(keysForPolicy(policy)).toBe("2\r");
  });

  test("a caller policy for OTHER kinds still gets the trust_prompt default", () => {
    const caller: InputPolicy = {
      byKind: { question: { kind: DispositionDeny } },
    };
    const policy = launchInputPolicy({
      harness: "claude-code",
      permissionMode: "bypass",
      inputPolicy: caller,
    });
    expect(policy?.byKind?.question).toEqual({ kind: DispositionDeny });
    expect(policy?.byKind?.trust_prompt?.optionID).toBe("proceed");
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

describe("permissionMode reaches the wrapper Config", () => {
  test("Open forwards it: `ask` launches claude with --permission-mode acceptEdits", async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), "pm-argv-")), "argv.json");
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
    const argvOut = join(mkdtempSync(join(tmpdir(), "pm-argv-")), "argv.json");
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();

    const conv = await openFake(script, { argvOut });
    open.add(conv);

    const argv = await readArgv(argvOut);
    expect(argv).not.toContain("--permission-mode");
  }, 20000);
});
