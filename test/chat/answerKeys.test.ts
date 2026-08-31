// answerKeys — the option-answer byte semantics extracted out of
// Conversation.writeAnswer. Both the chat layer and the screenbench recorder
// write these chunks, so the rules are frozen here directly rather than only
// through the Conversation that used to own them.
import { describe, expect, test } from "vitest";
import { answerKeys, findOption } from "../../src/chat/answerKeys.ts";
import {
  ErrNotMultiSelect,
  ErrUnknownOption,
  isSentinel,
} from "../../src/chat/errors.ts";
import {
  multiSelectQuestionRequest,
  questionRequest,
  trustRequest,
} from "./helpers.ts";

const dec = new TextDecoder();

/** The chunks as strings — the assertion also pins the CHUNK BOUNDARIES. */
function texts(chunks: Uint8Array[]): string[] {
  return chunks.map((c) => dec.decode(c));
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("answerKeys", () => {
  test("single-select emits just the chosen option's keys", () => {
    expect(texts(answerKeys(questionRequest(), { optionID: "2" }))).toEqual([
      "2",
    ]);
  });

  test("multi-select toggles each option in order, then submitKeys", () => {
    const keys = answerKeys(multiSelectQuestionRequest(), {
      optionIDs: ["3", "1"],
    });
    expect(texts(keys)).toEqual(["3", "1", "\t"]);
  });

  test("a single optionID on a multiSelect request toggles then commits", () => {
    // A bare toggle would never resolve the prompt, so it normalizes into the
    // same toggle-and-commit path as optionIDs.
    expect(
      texts(answerKeys(multiSelectQuestionRequest(), { optionID: "2" })),
    ).toEqual(["2", "\t"]);
  });

  test("optionIDs takes precedence over optionID", () => {
    const keys = answerKeys(multiSelectQuestionRequest(), {
      optionIDs: ["1"],
      optionID: "3",
    });
    expect(texts(keys)).toEqual(["1", "\t"]);
  });

  test("matches an option by alias, case-insensitively", () => {
    expect(texts(answerKeys(trustRequest(), { optionID: "PROCEED" }))).toEqual([
      "1\r",
    ]);
  });

  test("matches an option by label, case-insensitively", () => {
    expect(texts(answerKeys(questionRequest(), { optionID: "blue" }))).toEqual([
      "2",
    ]);
    expect(
      texts(answerKeys(trustRequest(), { optionID: "yes, PROCEED" })),
    ).toEqual(["1\r"]);
  });

  test("unknown option throws ErrUnknownOption", () => {
    expect(
      isSentinel(
        thrown(() => answerKeys(trustRequest(), { optionID: "nope" })),
        ErrUnknownOption,
      ),
    ).toBe(true);
  });

  test("an empty answer throws ErrUnknownOption", () => {
    expect(
      isSentinel(
        thrown(() => answerKeys(trustRequest(), {})),
        ErrUnknownOption,
      ),
    ).toBe(true);
    expect(
      isSentinel(
        thrown(() => answerKeys(multiSelectQuestionRequest(), {})),
        ErrUnknownOption,
      ),
    ).toBe(true);
  });

  test("multiple ids against a single-select request throw ErrNotMultiSelect", () => {
    expect(
      isSentinel(
        thrown(() => answerKeys(questionRequest(), { optionIDs: ["1", "2"] })),
        ErrNotMultiSelect,
      ),
    ).toBe(true);
  });

  test("a multiSelect request without submitKeys is not multi-select", () => {
    const req = multiSelectQuestionRequest();
    delete req.submitKeys;
    expect(
      isSentinel(
        thrown(() => answerKeys(req, { optionIDs: ["1", "2"] })),
        ErrNotMultiSelect,
      ),
    ).toBe(true);
    expect(texts(answerKeys(req, { optionIDs: ["1"] }))).toEqual(["1"]);
  });

  test("validate-all-then-write: one bad id emits nothing at all", () => {
    // The good ids in the same answer must NOT reach the caller as chunks —
    // this is what keeps a bad id from half-toggling a live dialog.
    expect(
      isSentinel(
        thrown(() =>
          answerKeys(multiSelectQuestionRequest(), {
            optionIDs: ["1", "nope", "2"],
          }),
        ),
        ErrUnknownOption,
      ),
    ).toBe(true);
  });

  test("throws synchronously, not as a rejected promise", () => {
    // tryResolveInput's fall-through-to-surface depends on this.
    expect(() => answerKeys(trustRequest(), { optionID: "nope" })).toThrow();
  });
});

describe("findOption", () => {
  test("matches on id, alias and label; empty string never matches", () => {
    const req = trustRequest();
    expect(findOption(req, "2")?.id).toBe("2");
    expect(findOption(req, "Deny")?.id).toBe("2");
    expect(findOption(req, "no, EXIT")?.id).toBe("2");
    expect(findOption(req, "")).toBeNull();
    expect(findOption(req, "missing")).toBeNull();
  });

  test("an option-less request matches nothing", () => {
    expect(
      findOption({ id: "t", kind: "text_input", prompt: "?" }, "1"),
    ).toBeNull();
  });
});
