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
export { env } from "./env.js";
export { compose } from "./compose.js";
export { local } from "./local.js";
export { none } from "./none.js";
export { shouldKeep, TeardownError } from "./retention.js";
export { argvToShell, envPrefixedShell, shQuote } from "./argv.js";
export { ContainerWorkspace, detectContainerRuntime } from "./container.js";
// Host-side structured-turn client (design §7). Imports the exit constants +
// result-schema type from src/turnproto (the ONE source of truth); turnproto is
// dependency-light and never reaches into src/cli, so this barrel stays clean.
export { runStructuredTurn, TurnProtocolError, TranscriptRetrievalUnsupportedError, } from "./turn.js";
//# sourceMappingURL=index.js.map