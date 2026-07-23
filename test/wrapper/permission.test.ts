import { describe, expect, test } from "vitest";
import {
  argsWithHarnessPermissionMode,
  harnessSupportsPermissionMode,
  isSupportedPermissionMode,
} from "../../src/wrapper/internal/permission.ts";
import { effectiveLaunchRung } from "../../src/wrapper/internal/permissionrungs.ts";

describe("argsWithHarnessPermissionMode", () => {
  const cases: {
    name: string;
    harness: string;
    args: string[];
    mode: string;
    want: string[];
  }[] = [
    // --- claude / claude-code: the full mapping table -----------------------
    {
      name: "claude plan",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "plan",
      want: ["--permission-mode", "plan", "-p", "prompt"],
    },
    {
      name: "claude manual",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "manual",
      want: ["--permission-mode", "manual", "-p", "prompt"],
    },
    {
      name: "claude ask emits the native acceptEdits value",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "ask",
      want: ["--permission-mode", "acceptEdits", "-p", "prompt"],
    },
    {
      name: "claude auto",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "auto",
      want: ["--permission-mode", "auto", "-p", "prompt"],
    },
    {
      name: "claude bypass emits the native bypassPermissions value",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "bypass",
      want: ["--permission-mode", "bypassPermissions", "-p", "prompt"],
    },
    {
      name: "claude native acceptEdits",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "acceptEdits",
      want: ["--permission-mode", "acceptEdits", "-p", "prompt"],
    },
    {
      name: "claude native bypassPermissions",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "bypassPermissions",
      want: ["--permission-mode", "bypassPermissions", "-p", "prompt"],
    },
    {
      name: "claude native dontAsk",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "dontAsk",
      want: ["--permission-mode", "dontAsk", "-p", "prompt"],
    },
    {
      name: "claude-code reaches the same claude path",
      harness: "claude-code",
      args: ["-p"],
      mode: "ask",
      want: ["--permission-mode", "acceptEdits", "-p"],
    },
    {
      name: "claude rejects codex-native sandbox values (no-op)",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "workspace-write",
      want: ["-p", "prompt"],
    },

    // --- codex: the pair arm ------------------------------------------------
    {
      name: "codex plan pins the permissions axis only",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "plan",
      want: ["-s", "read-only", "-a", "untrusted", "exec", "--json"],
    },
    {
      name: "codex manual is workspace-write, not read-only",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "manual",
      want: ["-s", "workspace-write", "-a", "untrusted", "exec", "--json"],
    },
    {
      name: "codex ask",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "ask",
      want: ["-s", "workspace-write", "-a", "on-request", "exec", "--json"],
    },
    {
      name: "codex auto",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "auto",
      want: ["-s", "workspace-write", "-a", "never", "exec", "--json"],
    },
    {
      name: "codex bypass",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "bypass",
      want: ["-s", "danger-full-access", "-a", "never", "exec", "--json"],
    },

    // --- codex: the single-axis arm ----------------------------------------
    {
      name: "codex native read-only sets the -s axis only",
      harness: "codex",
      args: ["exec"],
      mode: "read-only",
      want: ["-s", "read-only", "exec"],
    },
    {
      name: "codex native workspace-write sets the -s axis only",
      harness: "codex",
      args: ["exec"],
      mode: "workspace-write",
      want: ["-s", "workspace-write", "exec"],
    },
    {
      name: "codex native danger-full-access sets the -s axis only",
      harness: "codex",
      args: ["exec"],
      mode: "danger-full-access",
      want: ["-s", "danger-full-access", "exec"],
    },
    {
      name: "codex rejects claude-native acceptEdits (no-op)",
      harness: "codex",
      args: ["exec"],
      mode: "acceptEdits",
      want: ["exec"],
    },
    {
      name: "codex rejects claude-native bypassPermissions (no-op)",
      harness: "codex",
      args: ["exec"],
      mode: "bypassPermissions",
      want: ["exec"],
    },

    // --- degenerate inputs --------------------------------------------------
    {
      name: "empty mode leaves args unchanged",
      harness: "claude",
      args: ["-p", "prompt"],
      mode: "",
      want: ["-p", "prompt"],
    },
    {
      name: "unsupported harness leaves args unchanged",
      harness: "opencode",
      args: ["-p", "prompt"],
      mode: "plan",
      want: ["-p", "prompt"],
    },
    {
      name: "unknown value no-ops: the function never validates",
      harness: "codex",
      args: ["exec", "--json"],
      mode: "dontAsk",
      want: ["exec", "--json"],
    },
    {
      name: "junk value no-ops on claude too",
      harness: "claude",
      args: ["-p"],
      mode: "ultra",
      want: ["-p"],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(
        argsWithHarnessPermissionMode(tc.harness, tc.args, tc.mode),
      ).toEqual(tc.want);
    });
  }
});

describe("explicit override wins: injection is all-or-nothing", () => {
  const cases: { name: string; harness: string; args: string[] }[] = [
    {
      name: "claude --permission-mode X",
      harness: "claude",
      args: ["--permission-mode", "plan", "-p", "prompt"],
    },
    {
      name: "claude --permission-mode=X",
      harness: "claude",
      args: ["--permission-mode=plan", "-p", "prompt"],
    },
    {
      name: "claude --dangerously-skip-permissions",
      harness: "claude",
      args: ["--dangerously-skip-permissions", "-p", "prompt"],
    },
    {
      name: "claude --allow-dangerously-skip-permissions",
      harness: "claude-code",
      args: ["--allow-dangerously-skip-permissions", "-p", "prompt"],
    },
    {
      name: "codex -s X",
      harness: "codex",
      args: ["-s", "read-only", "exec"],
    },
    {
      name: "codex --sandbox=X",
      harness: "codex",
      args: ["--sandbox=read-only", "exec"],
    },
    {
      name: "codex attached short -sX",
      harness: "codex",
      args: ["-sread-only", "exec"],
    },
    {
      name: "codex -a X",
      harness: "codex",
      args: ["-a", "never", "exec"],
    },
    {
      name: "codex --ask-for-approval=X",
      harness: "codex",
      args: ["--ask-for-approval=never", "exec"],
    },
    {
      name: "codex -p NAME (profile can supply the axes we leave unset)",
      harness: "codex",
      args: ["-p", "wide", "exec"],
    },
    {
      name: "codex --profile=NAME",
      harness: "codex",
      args: ["--profile=wide", "exec"],
    },
    {
      name: "codex --dangerously-bypass-approvals-and-sandbox",
      harness: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox", "exec"],
    },
    {
      name: "codex -c sandbox_mode=",
      harness: "codex",
      args: ["-c", 'sandbox_mode="read-only"', "exec"],
    },
    {
      name: "codex -c approval_policy=",
      harness: "codex",
      args: ["-c", 'approval_policy="never"', "exec"],
    },
    {
      name: "codex attached -capproval_policy=",
      harness: "codex",
      args: ['-capproval_policy="never"', "exec"],
    },
    {
      name: "codex --config=sandbox_mode=",
      harness: "codex",
      args: ['--config=sandbox_mode="read-only"', "exec"],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      // Both axes must stay untouched — a half-injection would silently rewrite
      // the caller's intent.
      for (const mode of ["plan", "manual", "ask", "auto", "bypass"]) {
        expect(
          argsWithHarnessPermissionMode(tc.harness, tc.args, mode),
        ).toEqual(tc.args);
      }
    });
  }
});

describe("isSupportedPermissionMode", () => {
  const rungs = ["plan", "manual", "ask", "auto", "bypass"];

  test("the five canonical rungs are accepted on both harnesses", () => {
    for (const h of ["claude", "claude-code", "codex"]) {
      for (const rung of rungs) {
        expect(isSupportedPermissionMode(h, rung)).toBe(true);
      }
    }
  });

  test("claude-native spellings are claude-only", () => {
    for (const mode of ["acceptEdits", "bypassPermissions", "dontAsk"]) {
      expect(isSupportedPermissionMode("claude", mode)).toBe(true);
      expect(isSupportedPermissionMode("claude-code", mode)).toBe(true);
      expect(isSupportedPermissionMode("codex", mode)).toBe(false);
    }
  });

  test("codex-native sandbox values are codex-only", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      expect(isSupportedPermissionMode("codex", mode)).toBe(true);
      expect(isSupportedPermissionMode("claude", mode)).toBe(false);
      expect(isSupportedPermissionMode("claude-code", mode)).toBe(false);
    }
  });

  test("junk is rejected everywhere, case-sensitively", () => {
    for (const h of ["claude", "claude-code", "codex", "opencode", "pi"]) {
      expect(isSupportedPermissionMode(h, "ultra")).toBe(false);
      expect(isSupportedPermissionMode(h, "")).toBe(false);
    }
    // normHarness lowercases the harness, not the value.
    expect(isSupportedPermissionMode("claude", "acceptedits")).toBe(false);
    expect(isSupportedPermissionMode("claude", "Plan")).toBe(false);
    // …but the harness itself is normalized.
    expect(isSupportedPermissionMode("CLAUDE-CODE", "ask")).toBe(true);
  });

  test("unsupported harnesses accept nothing", () => {
    for (const rung of rungs) {
      expect(isSupportedPermissionMode("opencode", rung)).toBe(false);
      expect(isSupportedPermissionMode("pi", rung)).toBe(false);
    }
  });
});

test("harnessSupportsPermissionMode", () => {
  for (const h of ["claude", "claude-code", "codex", "CODEX", " claude "]) {
    expect(harnessSupportsPermissionMode(h)).toBe(true);
  }
  for (const h of ["opencode", "pi", ""]) {
    expect(harnessSupportsPermissionMode(h)).toBe(false);
  }
});

describe("the bypass rung has two spellings", () => {
  test("claude: bypass and bypassPermissions emit identical argv", () => {
    const args = ["-p", "prompt"];
    const want = ["--permission-mode", "bypassPermissions", "-p", "prompt"];
    expect(argsWithHarnessPermissionMode("claude", args, "bypass")).toEqual(
      want,
    );
    expect(
      argsWithHarnessPermissionMode("claude", args, "bypassPermissions"),
    ).toEqual(want);
    expect(isSupportedPermissionMode("claude", "bypass")).toBe(true);
    expect(isSupportedPermissionMode("claude", "bypassPermissions")).toBe(true);
  });

  test("codex: bypassPermissions is rejected exactly like dontAsk", () => {
    const args = ["exec", "--json"];
    expect(isSupportedPermissionMode("codex", "bypassPermissions")).toBe(false);
    expect(isSupportedPermissionMode("codex", "dontAsk")).toBe(false);
    expect(
      argsWithHarnessPermissionMode("codex", args, "bypassPermissions"),
    ).toEqual(args);
    // The canonical rung still works on codex.
    expect(argsWithHarnessPermissionMode("codex", args, "bypass")).toEqual([
      "-s",
      "danger-full-access",
      "-a",
      "never",
      "exec",
      "--json",
    ]);
  });
});

describe("idempotency over injection", () => {
  // permissionrungs.ts claims:
  //   effectiveLaunchRung(h, argsWithHarnessPermissionMode(h, args, mode), mode)
  //     === effectiveLaunchRung(h, args, mode)
  // — the cheapest guard that the emit table here and the shipped replay table
  // agree.
  const modes = [
    "plan",
    "manual",
    "ask",
    "auto",
    "bypass",
    "read-only",
    "workspace-write",
    "danger-full-access",
    "acceptEdits",
    "bypassPermissions",
    "dontAsk",
  ];
  for (const harness of ["claude", "claude-code", "codex"]) {
    for (const mode of modes) {
      test(`${harness} + ${mode}`, () => {
        for (const args of [[], ["exec", "--json"]]) {
          const injected = argsWithHarnessPermissionMode(harness, args, mode);
          expect(effectiveLaunchRung(harness, injected, mode)).toBe(
            effectiveLaunchRung(harness, args, mode),
          );
        }
      });
    }
  }
});
