// Tests for cleanHarnessEnv — the port of run.go's cleanedEnv that strips
// Claude Code's nesting markers so a nested `claude` persists its transcript.

import { describe, expect, test } from "vitest";
import { cleanHarnessEnv } from "../../src/chat/index.ts";
import { isClaudeNestingEnvKey } from "../../src/chat/env.ts";

describe("cleanHarnessEnv", () => {
  test("drops CLAUDECODE and CLAUDE_CODE_* but keeps everything else", () => {
    const got = cleanHarnessEnv([
      "PATH=/usr/bin",
      "CLAUDECODE=1",
      "CLAUDE_CODE_ENTRYPOINT=cli",
      "CLAUDE_CODE_SSE_PORT=1234",
      "TERM=xterm",
      "CLAUDE_CONFIG_DIR=/home/x/.claude", // NOT a nesting marker — kept
    ]);
    expect(got).toEqual([
      "PATH=/usr/bin",
      "TERM=xterm",
      "CLAUDE_CONFIG_DIR=/home/x/.claude",
    ]);
  });

  test("keeps CLAUDE_CODE (no trailing underscore) — neither exact nor prefixed", () => {
    expect(cleanHarnessEnv(["CLAUDE_CODE=x"])).toEqual(["CLAUDE_CODE=x"]);
  });

  test("treats an entry without '=' as a bare key", () => {
    expect(cleanHarnessEnv(["CLAUDECODE", "FOO"])).toEqual(["FOO"]);
  });

  test("preserves a value that itself contains '='", () => {
    expect(cleanHarnessEnv(["X=a=b=c"])).toEqual(["X=a=b=c"]);
  });

  test("an explicit empty env stays empty (no process.env materialization)", () => {
    expect(cleanHarnessEnv([])).toEqual([]);
  });

  test("materializes and cleans process.env when env is undefined", () => {
    const KEEP = "__MH57_KEEP__";
    const saved = {
      code: process.env.CLAUDECODE,
      ep: process.env.CLAUDE_CODE_ENTRYPOINT,
      keep: process.env[KEEP],
    };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env[KEEP] = "yes";
    try {
      const got = cleanHarnessEnv();
      expect(got.some((e) => e.startsWith("CLAUDECODE="))).toBe(false);
      // Narrow to the marker keys, NOT the whole CLAUDE_CODE_ prefix: the
      // OAUTH_TOKEN credential shares that prefix and must survive (PUPPET-309).
      expect(got.some((e) => e.startsWith("CLAUDE_CODE_ENTRYPOINT="))).toBe(
        false,
      );
      expect(got.some((e) => e.startsWith("CLAUDE_CODE_SSE_PORT="))).toBe(
        false,
      );
      expect(got).toContain(`${KEEP}=yes`);
    } finally {
      restore("CLAUDECODE", saved.code);
      restore("CLAUDE_CODE_ENTRYPOINT", saved.ep);
      restore(KEEP, saved.keep);
    }
  });

  test("isClaudeNestingEnvKey classifies keys", () => {
    expect(isClaudeNestingEnvKey("CLAUDECODE")).toBe(true);
    expect(isClaudeNestingEnvKey("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
    expect(isClaudeNestingEnvKey("CLAUDE_CODE_")).toBe(true);
    expect(isClaudeNestingEnvKey("CLAUDE_CODE")).toBe(false);
    expect(isClaudeNestingEnvKey("CLAUDE_CONFIG_DIR")).toBe(false);
    expect(isClaudeNestingEnvKey("PATH")).toBe(false);
  });

  test("CLAUDE_CODE_OAUTH_TOKEN is exempt — it is a credential, not a marker", () => {
    expect(isClaudeNestingEnvKey("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(
      cleanHarnessEnv([
        "CLAUDECODE=1",
        "CLAUDE_CODE_ENTRYPOINT=cli",
        "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-fake",
        "PATH=/usr/bin",
      ]),
    ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-fake", "PATH=/usr/bin"]);
  });

  test("the exemption is exact-match, not a prefix", () => {
    expect(isClaudeNestingEnvKey("CLAUDE_CODE_OAUTH_TOKEN_FILE")).toBe(true);
    expect(isClaudeNestingEnvKey("CLAUDE_CODE_OAUTH_TOKENX")).toBe(true);
    // env keys are case-sensitive on POSIX, and so is this predicate
    expect(isClaudeNestingEnvKey("claude_code_oauth_token")).toBe(false);
    expect(
      cleanHarnessEnv([
        "CLAUDE_CODE_OAUTH_TOKEN_FILE=/tmp/t",
        "CLAUDE_CODE_OAUTH_TOKENX=x",
      ]),
    ).toEqual([]);
  });

  test("an empty or bare CLAUDE_CODE_OAUTH_TOKEN is forwarded verbatim", () => {
    // The filter must not develop an opinion about the value — silently
    // dropping an empty token would resurrect the same invisible failure.
    expect(cleanHarnessEnv(["CLAUDE_CODE_OAUTH_TOKEN="])).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN=",
    ]);
    expect(cleanHarnessEnv(["CLAUDE_CODE_OAUTH_TOKEN"])).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  test("materialized process.env keeps the token while dropping the markers", () => {
    const saved = {
      code: process.env.CLAUDECODE,
      ep: process.env.CLAUDE_CODE_ENTRYPOINT,
      tok: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-fake";
    try {
      const got = cleanHarnessEnv();
      expect(got).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-fake");
      expect(got.some((e) => e.startsWith("CLAUDECODE="))).toBe(false);
      expect(got.some((e) => e.startsWith("CLAUDE_CODE_ENTRYPOINT="))).toBe(
        false,
      );
    } finally {
      restore("CLAUDECODE", saved.code);
      restore("CLAUDE_CODE_ENTRYPOINT", saved.ep);
      restore("CLAUDE_CODE_OAUTH_TOKEN", saved.tok);
    }
  });
});

function restore(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}
