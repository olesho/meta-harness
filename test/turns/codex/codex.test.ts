// Port of pkg/turns/harness/codex/codex_test.go.
// Corpus replay: bytes.raw → Screen → adapter, asserting no-fire on real
// (post-0.142) recordings and fire on the synthetic legacy footer.

import { describe, expect, test } from "vitest";
import { newScreen } from "../../../src/screen/index.ts";
import * as codex from "../../../src/turns/harness/codex.ts";
import {
  TurnComplete,
  InputRequested,
  InputResolved,
} from "../../../src/turns/index.ts";
import { corpusBytes } from "../corpus.ts";

describe("codex adapter", () => {
  test("no fire on real (0.142) recordings", async () => {
    for (const scenario of [
      "short-reply",
      "long-markdown",
      "code-block",
      "tool-call",
      "multi-turn",
    ]) {
      const bytes = corpusBytes("codex", scenario);
      expect(bytes).not.toBeNull();
      const scr = newScreen(120, 40);
      await scr.write(bytes!);
      for (const ev of codex.New().onScreen(scr.snapshot())) {
        expect(ev.kind).not.toBe(TurnComplete);
      }
    }
  });

  test("no fire on empty screen", () => {
    const scr = newScreen(80, 24);
    expect(codex.New().onScreen(scr.snapshot()).length).toBe(0);
  });

  test("refires when fingerprint changes", async () => {
    const scr = newScreen(120, 40);
    const a = codex.New();

    await scr.write(
      "\x1b[H\x1b[2JToken usage: total=100 input=80 (+ 50 cached) output=20\r\n",
    );
    expect(a.onScreen(scr.snapshot()).length).toBe(1);

    // Same fingerprint → no fire.
    expect(a.onScreen(scr.snapshot()).length).toBe(0);

    await scr.write(
      "\r\nToken usage: total=200 input=150 (+ 100 cached) output=50\r\n",
    );
    expect(a.onScreen(scr.snapshot()).length).toBe(1);
  });

  // Locks in the fix for a dropped resolve: when one interstitial gives way
  // DIRECTLY to a different one (no intervening dialog-free frame), the adapter
  // must emit InputResolved for the first BEFORE InputRequested for the second.
  // Without it the first request's identity/kind is lost — a client subscribed
  // from the start sees the replacement's kind on the eventual resolve (observed
  // live as an update notice resolving as codex_notice).
  test("interstitial transition resolves the previous one first", async () => {
    const scr = newScreen(120, 40);
    const a = codex.New();

    // Frame 1: the "Update available!" menu → InputRequested(codex_update_notice).
    await scr.write(
      "\x1b[H\x1b[2J" +
        "  Update available! 0.144.5 -> 0.144.6\r\n" +
        "› 1. Update now (runs `npm install -g @openai/codex`)\r\n" +
        "  2. Skip\r\n" +
        "  3. Skip until next version\r\n" +
        "  Press enter to continue\r\n",
    );
    const first = a.onScreen(scr.snapshot());
    expect(first.length).toBe(1);
    expect(first[0].kind).toBe(InputRequested);
    expect(first[0].input?.kind).toBe(codex.KindUpdateNotice);

    // Frame 2: the model-migration screen replaces it directly (no clear frame
    // between). Expect InputResolved(update) THEN InputRequested(migration).
    await scr.write(
      "\x1b[H\x1b[2J" +
        "  Choose how you'd like Codex to proceed\r\n" +
        "  Press enter to continue\r\n",
    );
    const second = a.onScreen(scr.snapshot());
    expect(second.length).toBe(2);
    expect(second[0].kind).toBe(InputResolved);
    expect(second[0].input?.kind).toBe(codex.KindUpdateNotice);
    expect(second[1].kind).toBe(InputRequested);
    expect(second[1].input?.kind).toBe(codex.KindModelMigration);
  });

  test("name", () => {
    expect(codex.New().name()).toBe("codex");
  });

  test("primeSessionIDKeys is /status + CSI 13 u", () => {
    const keys = codex.New().primeSessionIDKeys();
    expect(new TextDecoder().decode(keys)).toBe("/status\x1b[13u");
  });

  test("adversarial scenarios do not fire", async () => {
    for (const scenario of [
      "adversarial/prefix-only-marker",
      "adversarial/partial-stream-no-footer",
    ]) {
      const bytes = corpusBytes("codex", scenario);
      expect(bytes).not.toBeNull();
      const scr = newScreen(120, 40);
      await scr.write(bytes!);
      for (const ev of codex.New().onScreen(scr.snapshot())) {
        expect(ev.kind).not.toBe(TurnComplete);
      }
    }
  });
});
