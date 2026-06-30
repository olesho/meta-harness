import { expect, test } from "bun:test"
import { farewell, greet } from "../src/index.ts"

test("greet builds a greeting", () => {
  expect(greet("world")).toBe("Hello, world!")
})

test("farewell builds a farewell", () => {
  expect(farewell("world")).toBe("Goodbye, world!")
})
