import { expect, test } from "vitest";
import { VERSION } from "../src/index.ts";

test("library root exposes a VERSION string", () => {
  expect(typeof VERSION).toBe("string");
  expect(VERSION.length).toBeGreaterThan(0);
});

test("library root surfaces no scaffold placeholders", async () => {
  const mod = (await import("../src/index.ts")) as Record<string, unknown>;
  expect(mod.greet).toBeUndefined();
  expect(mod.farewell).toBeUndefined();
});
