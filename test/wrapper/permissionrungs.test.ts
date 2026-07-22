import { describe, expect, test } from "vitest";
import {
  effectiveLaunchRung,
  morePermissive,
  permissionRungs,
} from "../../src/wrapper/internal/permissionrungs.ts";

describe("permissionRungs", () => {
  test("exact ordered slice, least to most permissive", () => {
    expect(permissionRungs()).toEqual([
      "plan",
      "manual",
      "ask",
      "auto",
      "bypass",
    ]);
  });

  test("acceptEdits is NOT a rung — the canonical spelling is ask", () => {
    expect(permissionRungs()).not.toContain("acceptEdits");
  });

  test("a fresh array per call: mutating the result cannot corrupt a later one", () => {
    const first = permissionRungs();
    first.reverse();
    first.push("nonsense");
    expect(permissionRungs()).toEqual([
      "plan",
      "manual",
      "ask",
      "auto",
      "bypass",
    ]);
  });
});

describe("morePermissive", () => {
  const cases: { name: string; a: string; b: string; want: boolean }[] = [
    { name: "bypass over auto", a: "bypass", b: "auto", want: true },
    { name: "auto over plan", a: "auto", b: "plan", want: true },
    { name: "not strict: equal rungs", a: "ask", b: "ask", want: false },
    { name: "manual under ask", a: "manual", b: "ask", want: false },
    // Fail closed whenever EITHER side is not a canonical rung.
    { name: "empty a", a: "", b: "plan", want: false },
    { name: "empty b", a: "bypass", b: "", want: false },
    {
      name: "native spelling a (acceptEdits)",
      a: "acceptEdits",
      b: "plan",
      want: false,
    },
    {
      name: "native spelling b (danger-full-access)",
      a: "bypass",
      b: "danger-full-access",
      want: false,
    },
    { name: "typo a", a: "byapss", b: "plan", want: false },
    { name: "typo b", a: "bypass", b: "plann", want: false },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(morePermissive(tc.a, tc.b)).toBe(tc.want);
    });
  }
});

interface Case {
  name: string;
  harness: string;
  args: string[];
  mode: string;
  want: string;
}

function runCases(cases: Case[]): void {
  for (const tc of cases) {
    test(tc.name, () => {
      expect(effectiveLaunchRung(tc.harness, tc.args, tc.mode)).toBe(tc.want);
    });
  }
}

describe("effectiveLaunchRung — codex, the forward map (exact pairs)", () => {
  runCases([
    {
      name: "plan's emitted pair (read-only, untrusted) replays as manual, never plan",
      harness: "codex",
      args: ["-s", "read-only", "-a", "untrusted"],
      mode: "",
      want: "manual",
    },
    {
      name: "manual's emitted pair (workspace-write, untrusted) replays as manual",
      harness: "codex",
      args: ["-s", "workspace-write", "-a", "untrusted"],
      mode: "",
      want: "manual",
    },
    {
      name: "ask's emitted pair (workspace-write, on-request) replays as ask",
      harness: "codex",
      args: ["-sworkspace-write", "-aon-request"],
      mode: "",
      want: "ask",
    },
    {
      name: "auto's emitted pair (workspace-write, never) replays as auto",
      harness: "codex",
      args: ["--sandbox=workspace-write", "--ask-for-approval=never"],
      mode: "",
      want: "auto",
    },
    {
      name: "bypass's emitted pair (danger-full-access, never) replays as bypass",
      harness: "codex",
      args: ["-s", "danger-full-access", "-a", "never"],
      mode: "",
      want: "bypass",
    },
    {
      name: "a pair no rung emits — (read-only, never) — is UNKNOWN, not rounded to a neighbour",
      harness: "codex",
      args: ["-s", "read-only", "-a", "never"],
      mode: "",
      want: "",
    },
    {
      name: "unrecognized approval value is UNKNOWN",
      harness: "codex",
      args: ["-s", "workspace-write", "-a", "sometimes"],
      mode: "",
      want: "",
    },
  ]);
});

describe("effectiveLaunchRung — codex, the single-axis ceiling table", () => {
  runCases([
    {
      name: "bare -s read-only -> manual (the only rung emitting it is plan, which reports manual)",
      harness: "codex",
      args: ["-s", "read-only"],
      mode: "",
      want: "manual",
    },
    {
      name: "--sandbox=read-only -> manual",
      harness: "codex",
      args: ["--sandbox=read-only"],
      mode: "",
      want: "manual",
    },
    {
      name: "bare -s workspace-write -> auto (ceiling: approval is whatever config.toml holds)",
      harness: "codex",
      args: ["-s", "workspace-write"],
      mode: "",
      want: "auto",
    },
    {
      name: "attached -sworkspace-write -> auto (same posture, same answer)",
      harness: "codex",
      args: ["-sworkspace-write"],
      mode: "",
      want: "auto",
    },
    {
      name: "single-axis knob workspace-write -> auto (same posture as bare -s, one answer only)",
      harness: "codex",
      args: [],
      mode: "workspace-write",
      want: "auto",
    },
    {
      name: "-s=danger-full-access -> bypass",
      harness: "codex",
      args: ["-s=danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: "unrecognized sandbox value -> UNKNOWN",
      harness: "codex",
      args: ["-s", "moon-write"],
      mode: "",
      want: "",
    },
    {
      name: "a trailing -a leaves the sandbox axis on its ceiling",
      harness: "codex",
      args: ["-s", "workspace-write", "-a"],
      mode: "",
      want: "auto",
    },
  ]);
});

describe("effectiveLaunchRung — codex, unknowable posture reports UNKNOWN (never a definite non-bypass answer)", () => {
  runCases([
    {
      name: "-a present with NO -s -> UNKNOWN: injection was suppressed, the sandbox stayed at the harness default",
      harness: "codex",
      args: ["-a", "on-request"],
      mode: "auto",
      want: "",
    },
    {
      name: "--ask-for-approval=never with no -s -> UNKNOWN",
      harness: "codex",
      args: ["--ask-for-approval=never"],
      mode: "bypass",
      want: "",
    },
    // --profile: fires REGARDLESS of -s, in all four spellings.
    {
      name: "-p wide -> UNKNOWN even with -s present",
      harness: "codex",
      args: ["-s", "read-only", "-p", "wide"],
      mode: "",
      want: "",
    },
    {
      name: "--profile wide -> UNKNOWN even with -s present",
      harness: "codex",
      args: ["-s", "read-only", "--profile", "wide"],
      mode: "",
      want: "",
    },
    {
      name: "-pwide -> UNKNOWN even with -s present",
      harness: "codex",
      args: ["-s", "workspace-write", "-pwide"],
      mode: "",
      want: "",
    },
    {
      name: "--profile=wide -> UNKNOWN even with -s present",
      harness: "codex",
      args: ["-sworkspace-write", "--profile=wide"],
      mode: "",
      want: "",
    },
    {
      name: "--profile with an exact pair present -> still UNKNOWN (the profile can move the approval axis)",
      harness: "codex",
      args: ["-s", "workspace-write", "-a", "on-request", "--profile", "wide"],
      mode: "",
      want: "",
    },
    // sandbox_mode / approval_policy config overrides, all four spellings.
    {
      name: "-c sandbox_mode=read-only -> UNKNOWN",
      harness: "codex",
      args: ["-c", "sandbox_mode=read-only"],
      mode: "auto",
      want: "",
    },
    {
      name: "-csandbox_mode=read-only -> UNKNOWN",
      harness: "codex",
      args: ["-csandbox_mode=read-only"],
      mode: "auto",
      want: "",
    },
    {
      name: '--config sandbox_mode="read-only" -> UNKNOWN',
      harness: "codex",
      args: ["--config", 'sandbox_mode="read-only"'],
      mode: "auto",
      want: "",
    },
    {
      name: "--config=sandbox_mode=read-only -> UNKNOWN",
      harness: "codex",
      args: ["--config=sandbox_mode=read-only"],
      mode: "auto",
      want: "",
    },
    {
      name: "-c approval_policy=never -> UNKNOWN",
      harness: "codex",
      args: ["-c", "approval_policy=never"],
      mode: "auto",
      want: "",
    },
    {
      name: "-capproval_policy=never -> UNKNOWN",
      harness: "codex",
      args: ["-capproval_policy=never"],
      mode: "auto",
      want: "",
    },
    {
      name: '--config approval_policy="never" -> UNKNOWN',
      harness: "codex",
      args: ["--config", 'approval_policy="never"'],
      mode: "auto",
      want: "",
    },
    {
      name: "--config=approval_policy=never -> UNKNOWN, even alongside a readable -s",
      harness: "codex",
      args: ["-s", "workspace-write", "--config=approval_policy=never"],
      mode: "",
      want: "",
    },
    {
      name: "an unreadable -s (trailing flag, no operand) -> UNKNOWN",
      harness: "codex",
      args: ["exec", "-s"],
      mode: "auto",
      want: "",
    },
    {
      name: "an unreadable --sandbox -> UNKNOWN",
      harness: "codex",
      args: ["exec", "--sandbox"],
      mode: "auto",
      want: "",
    },
    {
      name: "an empty -s operand -> UNKNOWN",
      harness: "codex",
      args: ["-s", "", "exec"],
      mode: "auto",
      want: "",
    },
  ]);
});

describe("effectiveLaunchRung — codex, proof-of-unrestricted beats every unknowability rule", () => {
  runCases([
    {
      name: "-s danger-full-access + --profile -> bypass (a ceiling, not a floor)",
      harness: "codex",
      args: ["-s", "danger-full-access", "--profile", "wide"],
      mode: "",
      want: "bypass",
    },
    {
      name: "-sdanger-full-access + -c approval_policy=never -> bypass",
      harness: "codex",
      args: ["-sdanger-full-access", "-c", "approval_policy=never"],
      mode: "",
      want: "bypass",
    },
    {
      name: "-c sandbox_mode=danger-full-access -> bypass",
      harness: "codex",
      args: ["-c", "sandbox_mode=danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: '-c sandbox_mode="danger-full-access" (quoted, the emitted form) -> bypass',
      harness: "codex",
      args: ["-c", 'sandbox_mode="danger-full-access"'],
      mode: "",
      want: "bypass",
    },
    {
      name: "-csandbox_mode=danger-full-access -> bypass",
      harness: "codex",
      args: ["-csandbox_mode=danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: '-csandbox_mode="danger-full-access" -> bypass',
      harness: "codex",
      args: ['-csandbox_mode="danger-full-access"'],
      mode: "",
      want: "bypass",
    },
    {
      name: "--config sandbox_mode=danger-full-access -> bypass",
      harness: "codex",
      args: ["--config", "sandbox_mode=danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: '--config sandbox_mode="danger-full-access" -> bypass',
      harness: "codex",
      args: ["--config", 'sandbox_mode="danger-full-access"'],
      mode: "",
      want: "bypass",
    },
    {
      name: "--config=sandbox_mode=danger-full-access -> bypass",
      harness: "codex",
      args: ["--config=sandbox_mode=danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: '--config=sandbox_mode="danger-full-access" -> bypass',
      harness: "codex",
      args: ['--config=sandbox_mode="danger-full-access"'],
      mode: "",
      want: "bypass",
    },
    {
      name: "--dangerously-bypass-approvals-and-sandbox -> bypass, whatever the knob asked for",
      harness: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox", "exec"],
      mode: "manual",
      want: "bypass",
    },
    {
      name: "the bypass flag beats a restrictive -s in the same argv",
      harness: "codex",
      args: ["-s", "read-only", "--dangerously-bypass-approvals-and-sandbox"],
      mode: "",
      want: "bypass",
    },
  ]);
});

describe("effectiveLaunchRung — last-wins on duplicates", () => {
  runCases([
    {
      name: "duplicated -s: the LATER value wins",
      harness: "codex",
      args: ["-s", "read-only", "-s", "danger-full-access"],
      mode: "",
      want: "bypass",
    },
    {
      name: "duplicated -s the other way round: the later read-only wins",
      harness: "codex",
      args: ["-s", "danger-full-access", "-s", "read-only"],
      mode: "",
      want: "manual",
    },
    {
      name: "duplicated -a: the later approval wins",
      harness: "codex",
      args: ["-s", "workspace-write", "-a", "never", "-a", "untrusted"],
      mode: "",
      want: "manual",
    },
    {
      name: "duplicated sandbox_mode config keys: the later danger-full-access wins",
      harness: "codex",
      args: [
        "-c",
        "sandbox_mode=read-only",
        "-c",
        'sandbox_mode="danger-full-access"',
      ],
      mode: "",
      want: "bypass",
    },
    {
      name: "duplicated sandbox_mode config keys the other way round: the later read-only wins, so UNKNOWN",
      harness: "codex",
      args: [
        "-c",
        "sandbox_mode=danger-full-access",
        "-c",
        "sandbox_mode=read-only",
      ],
      mode: "",
      want: "",
    },
    {
      name: "claude: duplicated --permission-mode, the later value wins",
      harness: "claude",
      args: ["--permission-mode", "plan", "--permission-mode=acceptEdits"],
      mode: "",
      want: "ask",
    },
  ]);
});

describe("effectiveLaunchRung — codex, the knob arm (nothing in argv)", () => {
  runCases([
    {
      name: "manual knob -> manual",
      harness: "codex",
      args: [],
      mode: "manual",
      want: "manual",
    },
    {
      name: "ask knob -> ask",
      harness: "codex",
      args: [],
      mode: "ask",
      want: "ask",
    },
    {
      name: "auto knob -> auto",
      harness: "codex",
      args: [],
      mode: "auto",
      want: "auto",
    },
    {
      name: "bypass knob -> bypass",
      harness: "codex",
      args: [],
      mode: "bypass",
      want: "bypass",
    },
    {
      name: "plan knob -> manual: codex's plan emits (read-only, untrusted), which replays as manual",
      harness: "codex",
      args: [],
      mode: "plan",
      want: "manual",
    },
    {
      name: "native read-only knob -> manual",
      harness: "codex",
      args: [],
      mode: "read-only",
      want: "manual",
    },
    {
      name: "native danger-full-access knob -> bypass",
      harness: "codex",
      args: [],
      mode: "danger-full-access",
      want: "bypass",
    },
    {
      name: "no argv, no knob -> UNKNOWN",
      harness: "codex",
      args: ["exec"],
      mode: "",
      want: "",
    },
    {
      name: "unrecognized knob -> UNKNOWN",
      harness: "codex",
      args: [],
      mode: "yolo",
      want: "",
    },
  ]);
});

describe("effectiveLaunchRung — claude", () => {
  runCases([
    {
      name: "--permission-mode plan -> plan",
      harness: "claude",
      args: ["--permission-mode", "plan"],
      mode: "",
      want: "plan",
    },
    {
      name: "--permission-mode=acceptEdits normalizes to the canonical ask",
      harness: "claude",
      args: ["--permission-mode=acceptEdits"],
      mode: "",
      want: "ask",
    },
    {
      name: "--permission-mode bypassPermissions -> bypass",
      harness: "claude-code",
      args: ["--permission-mode", "bypassPermissions"],
      mode: "",
      want: "bypass",
    },
    {
      name: "argv wins over the knob, mirroring the suppression rule",
      harness: "claude",
      args: ["--permission-mode", "plan"],
      mode: "bypass",
      want: "plan",
    },
    {
      name: "knob acceptEdits -> ask",
      harness: "claude",
      args: [],
      mode: "acceptEdits",
      want: "ask",
    },
    {
      name: "dontAsk in argv has NO canonical rung -> UNKNOWN, never guessed into ask/auto",
      harness: "claude",
      args: ["--permission-mode", "dontAsk"],
      mode: "",
      want: "",
    },
    {
      name: "dontAsk as the knob -> UNKNOWN",
      harness: "claude",
      args: [],
      mode: "dontAsk",
      want: "",
    },
    {
      name: "trailing --permission-mode (no operand) -> UNKNOWN",
      harness: "claude",
      args: ["-p", "--permission-mode"],
      mode: "auto",
      want: "",
    },
    {
      name: "unrecognized --permission-mode spelling -> UNKNOWN",
      harness: "claude",
      args: ["--permission-mode", "AcceptEdits"],
      mode: "auto",
      want: "",
    },
    {
      name: "--dangerously-skip-permissions -> a definite bypass",
      harness: "claude",
      args: ["--dangerously-skip-permissions"],
      mode: "",
      want: "bypass",
    },
    {
      name: "--dangerously-skip-permissions beats a restrictive --permission-mode in the same argv",
      harness: "claude",
      args: ["--permission-mode", "plan", "--dangerously-skip-permissions"],
      mode: "plan",
      want: "bypass",
    },
    {
      name: "--allow-dangerously-skip-permissions is the other spelling and also -> bypass",
      harness: "claude-code",
      args: ["--permission-mode=plan", "--allow-dangerously-skip-permissions"],
      mode: "",
      want: "bypass",
    },
    {
      name: "no argv, no knob -> UNKNOWN",
      harness: "claude",
      args: ["-p", "hi"],
      mode: "",
      want: "",
    },
    {
      name: "harness name is normalized",
      harness: "  Claude-Code  ",
      args: [],
      mode: "auto",
      want: "auto",
    },
  ]);
});

describe("effectiveLaunchRung — harnesses with no launch-time permission axis", () => {
  runCases([
    {
      name: "opencode -> UNKNOWN even with a knob",
      harness: "opencode",
      args: ["--permission-mode", "plan"],
      mode: "bypass",
      want: "",
    },
    {
      name: "empty harness -> UNKNOWN",
      harness: "",
      args: [],
      mode: "auto",
      want: "",
    },
  ]);
});

// Idempotency over injection: replaying the rung on argv that already carries
// the injected directive must return the same rung the bare knob does. The
// injection half (permission.ts) does not exist yet, so the emitted argv is
// spelled out here from the forward map — that IS the contract being frozen.
describe("effectiveLaunchRung is idempotent over injection", () => {
  const codexInjection: Record<string, string[]> = {
    plan: ["-s", "read-only", "-a", "untrusted"],
    manual: ["-s", "workspace-write", "-a", "untrusted"],
    ask: ["-s", "workspace-write", "-a", "on-request"],
    auto: ["-s", "workspace-write", "-a", "never"],
    bypass: ["-s", "danger-full-access", "-a", "never"],
    // A codex-native sandbox knob sets the -s axis ONLY.
    "read-only": ["-s", "read-only"],
    "workspace-write": ["-s", "workspace-write"],
    "danger-full-access": ["-s", "danger-full-access"],
  };
  for (const [mode, injected] of Object.entries(codexInjection)) {
    test(`codex ${mode}`, () => {
      const bare = effectiveLaunchRung("codex", [], mode);
      expect(effectiveLaunchRung("codex", injected, mode)).toBe(bare);
      expect(effectiveLaunchRung("codex", [...injected, "exec"], mode)).toBe(
        bare,
      );
    });
  }

  const claudeInjection: Record<string, string> = {
    plan: "plan",
    manual: "manual",
    ask: "acceptEdits",
    auto: "auto",
    bypass: "bypassPermissions",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions",
  };
  for (const [mode, native] of Object.entries(claudeInjection)) {
    test(`claude ${mode}`, () => {
      const bare = effectiveLaunchRung("claude", [], mode);
      const injected = ["--permission-mode", native, "-p", "hi"];
      expect(effectiveLaunchRung("claude", injected, mode)).toBe(bare);
    });
  }
});
