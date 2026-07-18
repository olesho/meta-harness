// The "call us back" contract: mid-turn the harness asks the user a clarifying
// question (Claude Code's AskUserQuestion dialog), which must surface as an
// EventInputRequest — NOT complete, error, or silently hang the turn — and an
// answer() must resume the turn to completion. Driven end to end over a real
// pty with the scriptable fake harness (screen shapes verified live against
// claude-code 2.1.210; the live twin is test/chat/live_question.test.ts).

import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import {
  DispositionAnswer,
  EventInputRequest,
  EventInputResolved,
  EventTurn,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
  type Conversation,
  type ConversationEvent,
  type InputAnswer,
  type Turn,
} from "../../src/chat/index.ts";
import { New, openFake, sendOneTurn } from "./fakeharness.ts";

const open = new Set<Conversation>();

async function openTracked(
  script: Parameters<typeof openFake>[0],
  overrides: Parameters<typeof openFake>[1] = {},
): Promise<Conversation> {
  const conv = await openFake(script, overrides);
  open.add(conv);
  return conv;
}

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/** Answers the given request under the control token. */
async function answerRequest(
  conv: Conversation,
  id: string,
  ans: InputAnswer,
): Promise<void> {
  const ctx = Context.background();
  const release = await conv.acquireControl(ctx);
  try {
    await conv.answer(ctx, id, ans);
  } finally {
    release();
  }
}

interface DrainResult {
  turn: Turn;
  requests: ConversationEvent[];
  resolutions: ConversationEvent[];
}

/**
 * Drains conversation events until the assistant turn terminates, answering
 * every surfaced input request via `respond`. Returns the terminal turn plus
 * the observed request/resolution events, in order.
 */
async function driveToTerminalTurn(
  conv: Conversation,
  respond: (ev: ConversationEvent) => InputAnswer | null,
  timeoutMs: number,
): Promise<DrainResult> {
  const bus = conv.events();
  const requests: ConversationEvent[] = [];
  const resolutions: ConversationEvent[] = [];
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs),
  );
  for (;;) {
    const next = (async () => {
      const { value, ok } = await bus.receive();
      if (!ok) throw new Error("event channel closed before a terminal turn");
      return value!;
    })();
    const ev = await Promise.race([next, deadline]);
    if (ev.type === EventInputRequest) {
      requests.push(ev);
      const ans = respond(ev);
      if (ans) await answerRequest(conv, ev.input!.id, ans);
      continue;
    }
    if (ev.type === EventInputResolved) {
      resolutions.push(ev);
      continue;
    }
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete ||
        ev.turn.state === TurnStateErrored)
    ) {
      return { turn: ev.turn, requests, resolutions };
    }
  }
}

describe("question flow (real pty + fake harness)", () => {
  // The core "call us back" round trip: prompt in → question surfaces with the
  // parsed options → answer picks one → the turn resumes and completes with a
  // reply that reflects the choice.
  test("single question surfaces and an answer resumes the turn", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Question(30, " ☐ Color", "Which color should I use?", [
        ["Red", "Use red."],
        ["Blue", "Use blue."],
      ])
      .AwaitDigit()
      .QuestionAnswered(30, [["Which color should I use?", "Blue"]])
      .Reply(40, "CHOSEN: Blue", "Synthesized", "5s")
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Ask me which color to use");

    const { turn, requests, resolutions } = await driveToTerminalTurn(
      conv,
      (ev) => (ev.input!.kind === "question" ? { optionID: "Blue" } : null),
      8000,
    );

    expect(requests.length).toBe(1);
    const req = requests[0].input!;
    expect(req.kind).toBe("question");
    expect(req.prompt).toBe("Which color should I use?");
    expect(req.header).toBe("Color");
    expect(req.options!.map((o) => o.label)).toEqual([
      "Red",
      "Blue",
      "Type something.",
      "Chat about this",
    ]);
    expect(req.options![1].description).toBe("Use blue.");

    expect(resolutions.length).toBe(1);
    expect(resolutions[0].input!.id).toBe(req.id);

    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("CHOSEN: Blue");
  });

  // A two-question dialog: each question surfaces in sequence (the second
  // supersedes the first), the review pane surfaces as question_review, and
  // answering it completes the round trip.
  test("multi-question dialog: question, question, review, done", async () => {
    const colorQ = "Which color should I use?";
    const sizeQ = "Which size should I use?";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Question(30, "←  ☐ Color  ☐ Size  ✔ Submit  →", colorQ, [
        ["Red"],
        ["Blue"],
      ])
      .AwaitDigit()
      .Question(30, "←  ☒ Color  ☐ Size  ✔ Submit  →", sizeQ, [
        ["Small"],
        ["Large"],
      ])
      .AwaitDigit()
      .QuestionReview(30, "←  ☒ Color  ☒ Size  ✔ Submit  →", [
        [colorQ, "Blue"],
        [sizeQ, "Small"],
      ])
      .AwaitMenuChoice()
      .QuestionAnswered(30, [
        [colorQ, "Blue"],
        [sizeQ, "Small"],
      ])
      .Reply(40, "CHOSEN: Blue,Small", "Synthesized", "7s")
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Ask me two questions");

    const answers: Record<string, InputAnswer> = {
      [colorQ]: { optionID: "Blue" },
      [sizeQ]: { optionID: "Small" },
    };
    const { turn, requests, resolutions } = await driveToTerminalTurn(
      conv,
      (ev) =>
        ev.input!.kind === "question_review"
          ? { optionID: "proceed" }
          : (answers[ev.input!.prompt] ?? null),
      8000,
    );

    expect(requests.map((r) => r.input!.kind)).toEqual([
      "question",
      "question",
      "question_review",
    ]);
    expect(requests[0].input!.header).toBe("Color");
    expect(requests[1].input!.header).toBe("Size");
    expect(requests[2].input!.prompt).toContain(
      "Ready to submit your answers?",
    );
    // Every request resolves: two superseded, one answered away.
    expect(resolutions.length).toBe(3);

    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("CHOSEN: Blue,Small");
  });

  // An InputPolicy can resolve questions without a live client — nothing
  // surfaces, the turn just runs to completion.
  test("policy-answered question never surfaces", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Question(30, " ☐ Color", "Which color should I use?", [
        ["Red"],
        ["Blue"],
      ])
      .AwaitDigit()
      .QuestionAnswered(30, [["Which color should I use?", "Red"]])
      .Reply(40, "CHOSEN: Red", "Synthesized", "5s")
      .Build();

    const conv = await openTracked(script, {
      inputPolicy: {
        byKind: { question: { kind: DispositionAnswer, optionID: "1" } },
      },
    });
    await sendOneTurn(conv, "Ask me which color to use");

    const { turn, requests } = await driveToTerminalTurn(
      conv,
      () => null,
      8000,
    );
    expect(requests.length).toBe(0);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("CHOSEN: Red");
  });
});
