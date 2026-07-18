import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Type-aware strict linting: strictTypeChecked catches type-driven bugs (unsafe
// any, floating promises, unnecessary conditions) that the non-type-aware rules
// miss. It requires the TypeScript program, enabled below via projectService.
export default tseslint.config(
  // Build output, deps, coverage, and tooling config files (the config files are
  // not part of the tsconfig program, so type-aware rules can't resolve them).
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/*.config.{js,ts,mjs,cjs,mts,cts}",
      // Outside the tsconfig program (include: ["src","test"]) — type-aware
      // rules can't resolve them, so they only produced parser errors:
      //   - .orche/*: Orche pipeline agent definitions (separate concern)
      //   - **/*.mjs: build scripts + plain-JS test mocks / worker entrypoints
      ".orche/",
      "**/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Ruleset tuning for the in-progress Go→TS port. strictTypeChecked is kept as
  // the baseline, but the high-volume *strictness/style* rules are downgraded to
  // warnings so they don't block commits/CI while the port is finished — they
  // stay visible for incremental burn-down and can be promoted back to "error"
  // per rule as each is driven to zero. Genuine-bug rules (no-floating-promises,
  // no-misused-promises, await-thenable, etc.) intentionally stay at "error".
  {
    rules: {
      // Idiom/strictness noise from a hand-written port — not correctness bugs.
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/dot-notation": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/prefer-regexp-exec": "warn",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",
      "@typescript-eslint/restrict-plus-operands": "warn",
      "@typescript-eslint/no-dynamic-delete": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/only-throw-error": "warn",
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      // The `any`-in-tests family — noisy against fixtures/fakes, low bug value.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // Intentional `_`-prefixed params/vars are ignored; the rest warn.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Core-rule style noise.
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
      "no-useless-catch": "warn",
      "no-irregular-whitespace": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "warn",
    },
  },
);
