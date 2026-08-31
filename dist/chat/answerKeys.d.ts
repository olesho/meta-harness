import type { InputRequest as TurnsInputRequest, InputOption as TurnsInputOption } from "../turns/index.ts";
import type { InputAnswer } from "./types.ts";
/**
 * Resolves an answer's option reference against a request's options. Matches on
 * the stable `id`, or case-insensitively on `alias` or `label`.
 */
export declare function findOption(req: TurnsInputRequest, s: string): TurnsInputOption | null;
/**
 * The ordered byte chunks that answer an option-bearing request — write them to
 * the PTY in order, one write per chunk.
 *
 * Multi-select prompts: toggle every named option, then commit with the
 * request's submit keys (a single optionID answer is normalized into the same
 * toggle-and-commit path — a bare toggle would never resolve the prompt).
 * Validation of EVERY named option precedes any chunk being emitted, so a bad
 * id surfaces cleanly with nothing written.
 *
 * Throws ErrUnknownOption / ErrNotMultiSelect SYNCHRONOUSLY: callers on the
 * server side (tryResolveInput's fall-through-to-surface) depend on the first
 * validation happening before any promise is returned. Do not make this async.
 */
export declare function answerKeys(req: TurnsInputRequest, ans: InputAnswer): Uint8Array[];
//# sourceMappingURL=answerKeys.d.ts.map