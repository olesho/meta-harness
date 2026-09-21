// The API-error tag relabel, end to end over the REAL pty + fake harness, with the
// real ClaudeCodeAdapter reading a real transcript file.
//
// The failure it pins: claude paints a failed API call as an ordinary assistant
// bubble — "⏺ API Error: 529 Overloaded" — followed by a normal completion marker,
// so the screen path completes the turn as a SUCCESS whose reply is the error.
// Only the harness's own transcript tag says otherwise.
//
// It also pins the eligibility fix this port needed: before it, the pre-send
// watermark was gated on the codex-only swallow-override eligibility (readTranscript
// AND no extractMessage), so claude-code — which has extractMessage — never got a
// watermark, and a relabel keyed on it could never fire for the one harness that
// writes these tags. Case (a) fails if that gate regresses.
//
// Ordering matters in every case: the tagged line is appended AFTER send() returns,
// i.e. after the watermark was taken — anything written before it is history.
import { afterEach, describe, expect, test } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../../src/internal/async/index.ts";
import {
  CodeAuthRequired,
  CodeBillingWall,
  ReasonBillingWall,
  TurnStateComplete,
  TurnStateErrored,
  type Conversation,
} from "../../src/chat/index.ts";
import { claudecode } from "../../src/turns/index.ts";
import { encodedCWD } from "../../src/transcript/claudecode/claudecode.ts";
import {
  New,
  argvOutPath,
  openFake,
  readArgv,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";

const open = new Set<Conversation>();
const tmps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const U = (text: string) =>
  JSON.stringify({
    type: "user",
    uuid: "u-" + text,
    message: { role: "user", content: text },
  });
const A = (text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: "a-" + text,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text }],
    },
  });
const TAGGED = (tag: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: "t-" + tag,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
    isApiErrorMessage: true,
    error: tag,
  });

// Claude paints the error as a genuine-looking reply: bullet + FINAL marker.
//
// Timing is the trap here, in both directions. A single long pause after submit
// leaves the screen IDLE, and at testIdleGap (500ms) the swallow detector calls
// the prompt swallowed — a Working(500) raced it and lost under load. Too short
// a pause and completion reads the transcript before the test has appended the
// tagged line. So: a TRAIN of busy frames 60ms apart. Each one is output, which
// resets the idle clock (never idle for more than ~60ms, even at 4x load
// stretch), and together they span ~300ms, well past send() returning.
function errorBubbleScript(bubble: string) {
  return New("claude-code")
    .Idle()
    .AwaitSubmit()
    .Working(60, "Cerebrating")
    .Working(60, "Cerebrating")
    .Working(60, "Cerebrating")
    .Working(60, "Cerebrating")
    .Working(60, "Cerebrating")
    .Reply(60, bubble, "Synthesized", "3s")
    .StayAliveUntilStopped()
    .Build();
}

interface Harness {
  conv: Conversation;
  transcript: string;
}

async function openClaude(
  bubble: string,
  before: string[] = [],
): Promise<Harness> {
  const projectsRoot = tempDir("apierror-projects-");
  const workingDir = tempDir("apierror-wd-");
  const argvPath = argvOutPath("apierror-argv-");
  const conv = await openFake(errorBubbleScript(bubble), {
    workingDir,
    argvOut: argvPath,
  });
  open.add(conv);
  (conv.getAdapter() as claudecode.ClaudeCodeAdapter).projectsRoot =
    projectsRoot;
  const argv = await readArgv(argvPath);
  const sessionID = argv[argv.indexOf("--session-id") + 1];
  const dir = join(projectsRoot, encodedCWD(workingDir));
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, sessionID + ".jsonl");
  if (before.length > 0) writeFileSync(transcript, before.join("\n") + "\n");
  return { conv, transcript };
}

const append = (path: string, ...lines: string[]) => {
  appendFileSync(path, lines.join("\n") + "\n");
};

const bound = 10000;

describe("API-error tag relabel (real pty + fake claude + real transcript)", () => {
  // (a) The headline: a billing wall no screen regex can name, which the screen
  // path would otherwise complete as a success.
  test("a tagged billing_error errors the turn with the billing wall code", async () => {
    const bubble = "Credit balance is too low";
    const { conv, transcript } = await openClaude(bubble);
    await sendOneTurn(conv, "do the thing");
    append(transcript, U("do the thing"), TAGGED("billing_error", bubble));
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.code).toBe(CodeBillingWall);
    expect(turn.reason.startsWith(ReasonBillingWall)).toBe(true);
    expect(turn.reason).toContain("harness tag: billing_error");
    // The "reply" was the rendered error; it must not come back as the answer.
    expect(turn.text).toBe("");
  });

  // (b) The auth wall the screen CANNOT see: authRelabel is gated on an EMPTY
  // extraction, and the error bubble IS the extraction.
  test("a tagged authentication_failed errors the turn as auth_required", async () => {
    const bubble = "Failed to authenticate. API Error: 401 Unauthorized";
    const { conv, transcript } = await openClaude(bubble);
    await sendOneTurn(conv, "hello");
    append(transcript, U("hello"), TAGGED("authentication_failed", bubble));
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.code).toBe(CodeAuthRequired);
    expect(turn.text).toBe("");
  });

  // (c) A non-wall failure: errored, but with no code — a 500 is not a wall.
  test("a tagged overloaded errors the turn with no code", async () => {
    const bubble = "API Error: 529 Overloaded";
    const { conv, transcript } = await openClaude(bubble);
    await sendOneTurn(conv, "hello");
    append(transcript, U("hello"), TAGGED("overloaded", bubble));
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.code).toBeUndefined();
    expect(turn.reason).toBe(
      "claude-code: harness API error (harness tag: overloaded; API Error: 529 Overloaded)",
    );
  });

  // (d) LAST WORD ONLY: a 529 that the harness retried into a real answer.
  test("a tag followed by a real reply leaves the turn complete", async () => {
    const { conv, transcript } = await openClaude("the real answer");
    await sendOneTurn(conv, "hello");
    append(
      transcript,
      U("hello"),
      TAGGED("overloaded", "API Error: 529"),
      A("the real answer"),
    );
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.code).toBeUndefined();
    expect(turn.text).toContain("the real answer");
  });

  // (e) CORRELATION: a resumed session's earlier billing tag must never condemn
  // this turn. Written BEFORE the send, so the watermark puts it in history.
  test("a stale tag from before the send does not relabel this turn", async () => {
    const { conv } = await openClaude("fine now", [
      U("an earlier prompt"),
      TAGGED("billing_error", "Credit balance is too low"),
    ]);
    await sendOneTurn(conv, "hello");
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.code).toBeUndefined();
    expect(turn.text).toContain("fine now");
  });

  // (f) Baseline: no tag anywhere — the old behaviour, untouched.
  test("an untagged transcript leaves the turn exactly as before", async () => {
    const { conv, transcript } = await openClaude("plain answer");
    await sendOneTurn(conv, "hello");
    append(transcript, U("hello"), A("plain answer"));
    const turn = await waitForTerminalTurn(conv, bound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.code).toBeUndefined();
    expect(turn.text).toContain("plain answer");
  });
});
