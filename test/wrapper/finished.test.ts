// classifyFinishedOutput — ported from harness-wrapper's pkg/wrapper/finished_test.go.
//
// The tables are copied VERBATIM: the literal strings are the regression
// evidence, including the two production incidents the Go fixes were written for
// (#68: a log timestamp's millisecond field read as HTTP 402; #69: ordinary agent
// prose read as a fatal auth/billing wall). Where a test asserts a PRECONDITION on
// the plain classifyOutput, it doubles as a parity check between this repo's TS
// classifier and the Go one it was ported from.
import { describe, expect, test } from "vitest";
import { classifyOutput } from "../../src/wrapper/internal/classifier.ts";
import {
  RuleTimeoutUpgrade,
  classifyFinishedOutput,
} from "../../src/wrapper/internal/finished.ts";
import {
  ErrAuth,
  ErrBilling,
  ErrContextOverflow,
  ErrModelNotFound,
  ErrNone,
  ErrRateLimited,
  ErrTimeout,
  ErrTransient,
} from "../../src/wrapper/internal/errorclass.ts";

describe("classifyFinishedOutput — residual rows", () => {
  test.each([
    ["residual.ratelimit", "HTTP 429 from upstream", ErrRateLimited, "429"],
    [
      "residual.auth",
      "request rejected: unauthorized",
      ErrAuth,
      "unauthorized",
    ],
    [
      "residual.billing",
      "insufficient credits for this request",
      ErrBilling,
      "insufficient credits",
    ],
    [
      "residual.model_version",
      "this model requires a newer version",
      ErrModelNotFound,
      "model requires a newer version",
    ],
    [
      "residual.model_not_found",
      "unsupported model",
      ErrModelNotFound,
      "unsupported model",
    ],
    [
      "residual.context",
      "prompt too long",
      ErrContextOverflow,
      "prompt too long",
    ],
    ["residual.timeout", "etimedout", ErrTimeout, "etimedout"],
    [
      "residual.transient",
      "service unavailable",
      ErrTransient,
      "service unavailable",
    ],
  ])("every row fires by id: %s", (rule, text, cls, match) => {
    // The unknown harness reaches the residual table with no per-harness arm in
    // the way, which is what isolates the row under test.
    const got = classifyFinishedOutput("some-unknown-harness", text);
    expect(got.rule).toBe(rule);
    expect(got.class).toBe(cls);
    expect(got.match).toBe(match);
    expect(got.status).toBe("");
  });

  test.each([
    [
      "ratelimit beats transient",
      "upstream returned 429; also a 500 server error",
      "residual.ratelimit",
    ],
    [
      "auth beats billing",
      "401 unauthorized — check your billing",
      "residual.auth",
    ],
    [
      "billing beats model",
      "payment required; unsupported model",
      "residual.billing",
    ],
    [
      "timeout beats transient",
      "500 server error after connection timed out",
      "residual.timeout",
    ],
  ])("row order is precedence: %s", (_name, text, rule) => {
    expect(classifyFinishedOutput("some-unknown-harness", text).rule).toBe(
      rule,
    );
  });

  test("only the rate-limit row reads a retry-after hint", () => {
    const got = classifyFinishedOutput(
      "claude",
      "429 slow down\nretry-after: 45\n",
    );
    expect(got.rule).toBe("residual.ratelimit");
    expect(got.retryAfter).toBe(45_000);
    expect(
      classifyFinishedOutput("claude", "unauthorized\nretry-after: 45\n")
        .retryAfter,
    ).toBe(0);
  });

  test.each(["", "wrote 3 files, all tests pass"])(
    "nothing matched returns the original: %j",
    (out) => {
      const got = classifyFinishedOutput("claude", out);
      expect(got.rule).toBeUndefined();
      expect(got).toEqual(classifyOutput("claude", out));
    },
  );
});

describe("classifyFinishedOutput — refinements of a classifier verdict", () => {
  test("an ErrTransient whose surrounding text names a timeout becomes ErrTimeout", () => {
    const out =
      "Error: socket hang up\ncontext deadline exceeded while streaming";
    const before = classifyOutput("claude", out);
    expect(before.class, "precondition: TS classifier parity with Go").toBe(
      ErrTransient,
    );
    const got = classifyFinishedOutput("claude", out);
    expect(got.class).toBe(ErrTimeout);
    expect(got.rule).toBe(RuleTimeoutUpgrade);
    expect(got.status).toBe(before.status);
    expect(got.reason).toBe(before.reason);
    const plain = classifyFinishedOutput("claude", "Error: socket hang up");
    expect(plain.class).toBe(ErrTransient);
    expect(plain.rule).toBeUndefined();
  });

  test("a rate limit with no hint gets one from anywhere in the output", () => {
    const out = "Error: rate limit exceeded\nretry-after: 30";
    const before = classifyOutput("claude", out);
    expect(before.class, "precondition: TS classifier parity with Go").toBe(
      ErrRateLimited,
    );
    expect(before.retryAfter).toBe(0);
    const got = classifyFinishedOutput("claude", out);
    expect(got.retryAfter).toBe(30_000);
    expect(got.class).toBe(before.class);
    expect(got.reason).toBe(before.reason);
    expect(got.status).toBe(before.status);
  });

  test("a hint the matcher DID parse is never overwritten", () => {
    const got = classifyFinishedOutput(
      "claude",
      "API Error: 429 Too Many Requests. Retry after 30 seconds.\nretry-after: 999",
    );
    expect(got.retryAfter).toBe(30_000);
  });
});

describe("classifyFinishedOutput — #68: a timestamp is not a status code", () => {
  test("the incident that parked the fleet produces no verdict", () => {
    const incident = `time=2026-09-11T17:08:17.402+02:00 level=INFO msg="api issue backend created" url=http://127.0.0.1:3012 workspace=PUPPET
[daemon] not resuming Claude session: lock carries no claude session id (task )
Launching Claude agent (non-interactive)...

Error: claude-code: prompt not accepted / no assistant output; harness session id not known yet
`;
    const got = classifyFinishedOutput("claude", incident);
    expect(got.rule, `class=${got.class} match=${got.match}`).toBeUndefined();
  });

  test.each(["401", "402", "404", "429", "500", "502", "503", "529"])(
    "the whole class: millisecond .%s is not a status code",
    (ms) => {
      const line = `time=2026-09-11T17:08:17.${ms}+02:00 level=INFO msg="working"\nError: the turn produced no output\n`;
      expect(classifyFinishedOutput("claude", line).rule).toBeUndefined();
    },
  );

  test.each([
    ["upstream returned 429", "residual.ratelimit"],
    ["Error: 401 Unauthorized: invalid api key", "residual.auth"],
    ["402 payment required", "residual.billing"],
    ["HTTP 403 forbidden", "residual.auth"],
    ["upstream said 529", "residual.transient"],
    ["request failed with 503", "residual.transient"],
    [
      "time=2026-09-11T17:08:17.402+02:00 starting\nError: 429 too many requests\n",
      "residual.ratelimit",
    ],
  ])("a real status code survives the guard: %j", (text, rule) => {
    expect(classifyFinishedOutput("some-unknown-harness", text).rule).toBe(
      rule,
    );
  });
});

describe("classifyFinishedOutput — #69: a row may only match text naming an API failure", () => {
  test.each([
    "Error: open /etc/hosts: permission denied",
    "mkdir /usr/local/x: permission denied",
    "panic: EACCES: permission denied, open '/var/db'",
    "invalid key in the yaml map",
    "reading ANTHROPIC_API_KEY from the environment",
    "export OPENAI_API_KEY=... then rerun",
    "ANTHROPIC_API_KEY is configured\nthe cache is missing an entry",
    "the billing module needs a migration",
    "docs/billing.md updated",
    "added a quota field to the config",
    "credits roll over monthly per the spec",
    "this is taking too long, splitting the task",
    "the response was too long to inline",
  ])("ordinary output is not an API failure: %j", (text) => {
    const got = classifyFinishedOutput("claude", text);
    expect(got.rule, `class=${got.class} match=${got.match}`).toBeUndefined();
  });

  test.each([
    ["Error: 401 Unauthorized: invalid api key", "residual.auth", ErrAuth],
    ["request rejected: unauthorized", "residual.auth", ErrAuth],
    ["HTTP 403 forbidden", "residual.auth", ErrAuth],
    ["authentication failed", "residual.auth", ErrAuth],
    ["Error: OPENAI_API_KEY is not set", "residual.auth", ErrAuth],
    ["missing ANTHROPIC_API_KEY", "residual.auth", ErrAuth],
    ["CURSOR_API_KEY is required", "residual.auth", ErrAuth],
    ["incorrect api key provided", "residual.auth", ErrAuth],
    ["402 payment required", "residual.billing", ErrBilling],
    ["insufficient credits for this request", "residual.billing", ErrBilling],
    ["insufficient_quota", "residual.billing", ErrBilling],
    ["you have exceeded your monthly quota", "residual.billing", ErrBilling],
    [
      "prompt too long for the context window",
      "residual.context",
      ErrContextOverflow,
    ],
    ["maximum context length exceeded", "residual.context", ErrContextOverflow],
  ])("a real API failure survives the narrowing: %j", (text, rule, cls) => {
    const got = classifyFinishedOutput("claude", text);
    expect(got.rule).toBe(rule);
    expect(got.class).toBe(cls);
  });
});

describe("regex translation fidelity", () => {
  test("`.` spans a carriage return, as Go's `.` does (PTY output is full of \\r)", () => {
    // Go's `.` excludes only \n; JS's also excludes \r. The port writes `[^\n]`.
    const got = classifyFinishedOutput(
      "some-unknown-harness",
      "the model gpt-9\rnot found upstream",
    );
    expect(got.rule).toBe("residual.model_not_found");
  });
});

describe("classifyOutput is unchanged by the fallback", () => {
  test("the plain one-shot never consults the residual rows", () => {
    // A residual-only signal: the per-harness arms do not model it.
    const got = classifyOutput(
      "some-unknown-harness",
      "maximum context length exceeded",
    );
    expect(got.class).toBe(ErrNone);
    expect(got.rule).toBeUndefined();
  });
});
