import { expect, test } from "bun:test"
import { greet } from "../src/index.ts"

test("greet builds a greeting", () => {
  expect(greet("world")).toBe("Hello, world!")
})
