// Port of pkg/chat/input_test.go — policy/handler resolution, surfacing, Answer.
import { describe, expect, test } from "vitest";
import { Context } from "../../src/internal/async/index.ts";
import {
  ErrNoControl,
  ErrNoInputPending,
  ErrNotMultiSelect,
  ErrStaleInputRequest,
  ErrUnknownOption,
  isSentinel,
} from "../../src/chat/errors.ts";
import {
  EventInputRequest,
  EventInputResolved,
  DispositionAnswer,
  DispositionDeny,
} from "../../src/chat/types.ts";
import {
  KeyRecorder,
  multiSelectQuestionRequest,
  newTestConv,
  questionRequest,
  trustRequest,
} from "./helpers.ts";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("handleInputRequested", () => {
  test("policy answer auto-resolves server-side, nothing surfaced", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      {
        harness: "claude-code",
        inputPolicy: {
          byKind: {
            trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
          },
        },
      },
      rec,
    );
    c.handleInputRequested(trustRequest());
    expect(rec.text()).toBe("1\r");
    expect(c.inputSurfaced).toBe(false);
    expect(c.currentInput).not.toBeNull();
    expect(c.eventCh.tryReceive().ok).toBe(false);
  });

  test("policy deny picks the deny-aliased option", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      { harness: "claude-code", inputPolicy: { default: DispositionDeny } },
      rec,
    );
    c.handleInputRequested(trustRequest());
    expect(rec.text()).toBe("2\r");
  });

  test("in-process handler resolves when policy says ask", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      {
        harness: "claude-code",
        onInputRequest: (r) =>
          r.kind === "trust_prompt"
            ? [{ optionID: "deny" }, true]
            : [{}, false],
      },
      rec,
    );
    c.handleInputRequested(trustRequest());
    expect(rec.text()).toBe("2\r");
    expect(c.inputSurfaced).toBe(false);
  });

  test("no policy/handler surfaces to client and marks awaiting", () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    c.handleInputRequested(trustRequest());
    expect(rec.data.length).toBe(0);
    expect(c.inputAwaitingClient()).toBe(true);
    const { value, ok } = c.eventCh.tryReceive();
    expect(ok).toBe(true);
    expect(value!.type).toBe(EventInputRequest);
    expect(value!.input!.id).toBe("req-1");
    expect(value!.input!.options!.length).toBe(2);
    expect(value!.input!.options![0].label).toBe("Yes, proceed");
  });
});

describe("Answer", () => {
  test("precondition + resolution flow", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);

    expect(
      isSentinel(
        await caught(
          c.answer(Context.background(), "req-1", { optionID: "proceed" }),
        ),
        ErrNoControl,
      ),
    ).toBe(true);

    const release = await c.queue.acquire(Context.background());
    try {
      expect(
        isSentinel(
          await caught(
            c.answer(Context.background(), "", { optionID: "proceed" }),
          ),
          ErrNoInputPending,
        ),
      ).toBe(true);

      c.handleInputRequested(trustRequest());

      expect(
        isSentinel(
          await caught(
            c.answer(Context.background(), "wrong-id", { optionID: "proceed" }),
          ),
          ErrStaleInputRequest,
        ),
      ).toBe(true);
      expect(
        isSentinel(
          await caught(
            c.answer(Context.background(), "req-1", { optionID: "nope" }),
          ),
          ErrUnknownOption,
        ),
      ).toBe(true);
      await c.answer(Context.background(), "req-1", { optionID: "proceed" });
      expect(rec.text()).toBe("1\r");
    } finally {
      release();
    }
  });
});

describe("Answer: question prompts", () => {
  test("single-select question answers with the bare digit", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    const release = await c.queue.acquire(Context.background());
    try {
      c.handleInputRequested(questionRequest());
      const { value, ok } = c.eventCh.tryReceive();
      expect(ok).toBe(true);
      expect(value!.type).toBe(EventInputRequest);
      expect(value!.input!.kind).toBe("question");
      expect(value!.input!.header).toBe("Color");
      expect(value!.input!.options![0].description).toBe("Use red.");

      // Label matching works alongside ids; the answer is the digit alone —
      // in a multi-question dialog a trailing CR would leak into the NEXT
      // question pane and select its highlighted option.
      await c.answer(Context.background(), "q-1", { optionID: "Blue" });
      expect(rec.text()).toBe("2");
    } finally {
      release();
    }
  });

  test("multi-select toggles every named option then commits", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    const release = await c.queue.acquire(Context.background());
    try {
      c.handleInputRequested(multiSelectQuestionRequest());
      await c.answer(Context.background(), "q-ms-1", {
        optionIDs: ["1", "Olives"],
      });
      expect(rec.text()).toBe("13\t");
    } finally {
      release();
    }
  });

  test("multi-select normalizes a single optionID into toggle-and-commit", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    const release = await c.queue.acquire(Context.background());
    try {
      c.handleInputRequested(multiSelectQuestionRequest());
      await c.answer(Context.background(), "q-ms-1", { optionID: "2" });
      expect(rec.text()).toBe("2\t");
    } finally {
      release();
    }
  });

  test("multiple optionIDs on a single-select prompt is rejected", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    const release = await c.queue.acquire(Context.background());
    try {
      c.handleInputRequested(questionRequest());
      const err = await caught(
        c.answer(Context.background(), "q-1", { optionIDs: ["1", "2"] }),
      );
      expect(isSentinel(err, ErrNotMultiSelect)).toBe(true);
      expect(rec.data.length).toBe(0);
    } finally {
      release();
    }
  });

  test("unknown id among optionIDs writes nothing", async () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    const release = await c.queue.acquire(Context.background());
    try {
      c.handleInputRequested(multiSelectQuestionRequest());
      const err = await caught(
        c.answer(Context.background(), "q-ms-1", { optionIDs: ["1", "nope"] }),
      );
      expect(isSentinel(err, ErrUnknownOption)).toBe(true);
      expect(rec.data.length).toBe(0);
    } finally {
      release();
    }
  });
});

describe("pendingInput", () => {
  test("mirrors the surfaced request and clears on resolve", () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    expect(c.pendingInput()).toBeNull();

    c.handleInputRequested(questionRequest());
    const pending = c.pendingInput();
    expect(pending).not.toBeNull();
    expect(pending!.kind).toBe("question");
    expect(pending!.prompt).toBe("Which color should I use?");
    expect(pending!.options!.map((o) => o.label)).toEqual([
      "Red",
      "Blue",
      "Type something.",
      "Chat about this",
    ]);
    // The client view never exposes keystrokes.
    expect("keys" in pending!.options![0]).toBe(false);

    c.handleInputResolved({ id: "q-1", kind: "", prompt: "" });
    expect(c.pendingInput()).toBeNull();
  });

  test("policy-resolved requests are not pending for the client", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      {
        harness: "claude-code",
        inputPolicy: {
          byKind: { question: { kind: DispositionAnswer, optionID: "1" } },
        },
      },
      rec,
    );
    c.handleInputRequested(questionRequest());
    expect(rec.text()).toBe("1");
    expect(c.pendingInput()).toBeNull();
  });
});

describe("handleInputResolved", () => {
  test("clears pending and notifies", () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "claude-code" }, rec);
    c.handleInputRequested(trustRequest());
    expect(c.eventCh.tryReceive().ok).toBe(true); // drain the surfaced request

    c.handleInputResolved({ id: "req-1", kind: "", prompt: "" });
    expect(c.currentInput).toBeNull();
    expect(c.inputAwaitingClient()).toBe(false);
    const { value, ok } = c.eventCh.tryReceive();
    expect(ok).toBe(true);
    expect(value!.type).toBe(EventInputResolved);
  });
});
