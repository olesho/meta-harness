// Adapter-level coverage for the HookProviderCapability wired onto the Claude
// adapter (META-HARNESS-72). Two things are verified here:
//
//   1. Structural recognition — only the Claude adapter exposes hookProvider();
//      codex / opencode / pi / generic do NOT (Go-optional-interface style, the
//      same way TranscriptReader / SessionIDExtractor are probed).
//   2. ensureConfig idempotency + co-tenancy — driven THROUGH the adapter's
//      HookProvider, repeated ensureConfig yields exactly one managed block per
//      event and preserves a co-tenant block.

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveAdapter } from "../../../src/chat/conversation.ts";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import type {
  Adapter,
  HookProviderCapability,
} from "../../../src/turns/types.ts";
import {
  isManagedHookCommand,
  type HookContext,
  type SettingsHookMatcher,
} from "../../../src/hooks/index.ts";

// probe mirrors the Go-optional-interface structural check the chat layer runs:
// an Adapter implements HookProviderCapability iff it carries hookProvider().
function probe(a: Adapter): HookProviderCapability | undefined {
  const cap = a as Partial<HookProviderCapability>;
  return typeof cap.hookProvider === "function"
    ? (cap as HookProviderCapability)
    : undefined;
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mh-cc-hooks-"));
}

// A co-tenant block that must survive every ensure — models e.g. a Go
// harness-wrapper's own hook entry, which lacks our marker.
const coTenant: SettingsHookMatcher = {
  matcher: "*",
  hooks: [
    { type: "command", command: "/opt/other-harness/wrap.sh # other-harness" },
  ],
};

function managedMatchers(
  matchers: SettingsHookMatcher[],
): SettingsHookMatcher[] {
  return matchers.filter((m) =>
    m.hooks.some((h) => isManagedHookCommand(h.command)),
  );
}

describe("Claude adapter HookProviderCapability — structural recognition", () => {
  test("claude-code is structurally recognized as a HookProviderCapability", () => {
    expect(probe(resolveAdapter("claude-code"))).toBeDefined();
  });

  test("codex / opencode / pi / generic are NOT", () => {
    for (const name of ["codex", "opencode", "pi", "generic"]) {
      expect(probe(resolveAdapter(name))).toBeUndefined();
    }
  });
});

describe("Claude adapter ensureConfig — idempotency + co-tenancy", () => {
  // Build a Claude adapter with pinned node/dist so rendered commands are stable
  // and independent of the ambient interpreter / dist layout.
  function newAdapter(): claudecode.ClaudeCodeAdapter {
    const a = claudecode.New();
    a.nodePath = "/usr/local/bin/node";
    a.distDir = "/opt/meta-harness/dist";
    return a;
  }

  function ctxFor(dir: string): HookContext {
    return { cwd: dir, home: dir, configDir: dir, spoolDir: dir };
  }

  test("ensureConfig writes the managed block and returns a matching spec", () => {
    const dir = tempDir();
    const provider = newAdapter().hookProvider();
    const spec = provider.ensureConfig(ctxFor(dir));

    // The returned spec points at settings.json and carries rendered commands.
    expect(spec.configPath).toBe(path.join(dir, "settings.json"));
    expect(spec.events.length).toBeGreaterThan(0);
    for (const entry of spec.events) {
      expect(isManagedHookCommand(entry.command)).toBe(true);
    }

    const settings = JSON.parse(readFileSync(spec.configPath, "utf8"));
    for (const entry of spec.events) {
      expect(managedMatchers(settings.hooks[entry.event])).toHaveLength(1);
    }
    // Lock + tmp are cleaned up by the O_EXCL primitive.
    expect(existsSync(`${spec.configPath}.lock`)).toBe(false);
    expect(existsSync(`${spec.configPath}.tmp`)).toBe(false);
  });

  test("repeated ensureConfig yields exactly one managed block per event", () => {
    const dir = tempDir();
    const provider = newAdapter().hookProvider();
    const ctx = ctxFor(dir);

    let spec = provider.ensureConfig(ctx);
    for (let i = 0; i < 4; i++) spec = provider.ensureConfig(ctx);

    const settings = JSON.parse(readFileSync(spec.configPath, "utf8"));
    for (const entry of spec.events) {
      expect(managedMatchers(settings.hooks[entry.event])).toHaveLength(1);
    }
  });

  test("preserves a co-tenant block across repeated ensureConfig", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    // Seed a co-tenant block under the Stop event before any ensure.
    writeFileSync(
      cfg,
      JSON.stringify({ hooks: { Stop: [coTenant] } }, null, 2),
    );

    const provider = newAdapter().hookProvider();
    const ctx = ctxFor(dir);
    provider.ensureConfig(ctx);
    provider.ensureConfig(ctx);

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    const stopCmds = settings.hooks.Stop.flatMap((m: SettingsHookMatcher) =>
      m.hooks.map((h) => h.command),
    );
    // Exactly one managed Stop command + the untouched co-tenant.
    expect(stopCmds.filter(isManagedHookCommand)).toHaveLength(1);
    expect(stopCmds).toContain(coTenant.hooks[0].command);
  });

  test("parsePayload delegates to the Claude payload parser", () => {
    const dir = tempDir();
    const provider = newAdapter().hookProvider();
    const raw = JSON.stringify({
      session_id: "s1",
      hook_event_name: "Stop",
    });
    const events = provider.parsePayload(raw, {
      ...ctxFor(dir),
      harnessSessionID: "s1",
    });
    expect(events.length).toBeGreaterThan(0);
    // A stray session is dropped by the mismatch guard.
    const dropped = provider.parsePayload(raw, {
      ...ctxFor(dir),
      harnessSessionID: "other",
    });
    expect(dropped).toHaveLength(0);
  });
});
