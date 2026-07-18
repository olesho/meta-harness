// Deterministic parser tests: replay the recorded `/model` picker fixtures into
// a Screen and assert parseModelPicker returns the expected model list — plus
// the curated isKnownModel/knownModels registry checks. No live CLI.

import { describe, expect, test } from "vitest";
import { newScreen } from "../../src/screen/index.ts";
import {
  parseModelPicker,
  isKnownModel,
  knownModels,
  defaultModel,
} from "../../src/discovery/models.ts";
import { corpusBytes } from "../turns/corpus.ts";

async function pickerText(harness: string, scenario: string): Promise<string> {
  const bytes = corpusBytes(harness, scenario);
  expect(bytes).not.toBeNull();
  const scr = newScreen(120, 40);
  await scr.write(bytes!);
  return scr.snapshot().text;
}

describe("parseModelPicker: claude-code", () => {
  test("lists the picker models with current/default flags", async () => {
    const text = await pickerText("claude-code", "model-picker");
    const models = parseModelPicker(text, "claude-code");
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);

    const opus = models.find((m) => m.id === "opus")!;
    expect(opus.current).toBe(true); // marked with ✔ in the recording
    expect(opus.description).toContain("Opus 4.8");

    const def = models.find((m) => m.id === "default")!;
    expect(def.isDefault).toBe(true);
    // Only the active model carries current.
    expect(models.filter((m) => m.current).map((m) => m.id)).toEqual(["opus"]);
  });
});

describe("parseModelPicker: codex", () => {
  test("lists the picker models with current/default flags", async () => {
    const text = await pickerText("codex", "model-picker");
    const models = parseModelPicker(text, "codex");
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);

    expect(models.find((m) => m.id === "gpt-5.5")!.isDefault).toBe(true);
    expect(models.find((m) => m.id === "gpt-5.4-mini")!.current).toBe(true);
  });
});

describe("parseModelPicker: guards", () => {
  test("non-picker screen yields no models", () => {
    expect(
      parseModelPicker("1. not a picker  just a list", "claude-code"),
    ).toEqual([]);
  });
  test("unsupported harness yields no models", async () => {
    const text = await pickerText("claude-code", "model-picker");
    expect(parseModelPicker(text, "opencode")).toEqual([]);
  });
});

describe("knownModels / isKnownModel / defaultModel", () => {
  test("claude-code known ids and aliases", () => {
    expect(knownModels("claude-code")).toContain("opus");
    expect(knownModels("claude-code")).toContain("claude-opus-4-8");
    expect(isKnownModel("claude-code", "Opus")).toBe(true); // case-insensitive
    expect(isKnownModel("claude", "sonnet")).toBe(true); // harness normalized
    expect(isKnownModel("claude-code", "gpt-5.5")).toBe(false);
    expect(defaultModel("claude-code")).toBe("opus");
  });
  test("codex known ids", () => {
    expect(isKnownModel("codex", "gpt-5.4-mini")).toBe(true);
    expect(isKnownModel("codex", "o3")).toBe(false);
    expect(defaultModel("codex")).toBe("gpt-5.5");
  });
  test("unknown harness / empty model", () => {
    expect(knownModels("opencode")).toEqual([]);
    expect(isKnownModel("opencode", "anything")).toBe(false);
    expect(isKnownModel("claude-code", "")).toBe(false);
  });
});
