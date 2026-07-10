// Public barrel for `meta-harness/env`.
//
// The environment-layer core (design §3–§6): the two-axis interfaces, the
// core-owned lifecycle engine (env), the compose() combinator, and the shipped
// degenerate implementations (`local` provisioner, `none` containment).
//
// Barrel discipline (enforced by test/exports-guard.test.ts): this file NEVER
// imports from src/internal/** and NEVER runtime-exports `Context`. The `Context`
// type is referenced by the interfaces below only through the sanctioned public
// seam (`meta-harness/async`); it is erased at runtime, so re-exporting the
// interface types that mention it does not surface Context as a value.

export type {
  Capability,
  Containment,
  ContainmentLayer,
  CredentialInjector,
  EnvConfig,
  Environment,
  ExecOpts,
  ExecResult,
  Outcome,
  PolicySpec,
  Provisioner,
  Redactor,
  Retention,
  Workspace,
  WorkspaceSpec,
} from "./types.ts"

export { env } from "./env.ts"
export { compose } from "./compose.ts"
export { local } from "./local.ts"
export { none } from "./none.ts"
export { shouldKeep, TeardownError } from "./retention.ts"
export { argvToShell, envPrefixedShell, shQuote } from "./argv.ts"
