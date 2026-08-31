// answerKeys — the byte-level semantics of answering an option-bearing input
// request, as one pure function.
//
// These rules used to live inline in Conversation.writeAnswer. They are pulled
// out because a second caller (the screenbench recorder) must answer a pending
// dialog by writing EXACTLY the bytes the chat layer writes; a copy there would
// fork the semantics on the first change to either side.
//
// Deliberately NOT exported from src/chat/index.ts: the public subpath barrels
// are frozen by test/testdata/ts_surface.golden. Consumers deep-import this
// module.

import type {
  InputRequest as TurnsInputRequest,
  InputOption as TurnsInputOption,
} from "../turns/index.ts";
import type { InputAnswer } from "./types.ts";
import { ErrUnknownOption, ErrNotMultiSelect } from "./errors.ts";

/**
 * Resolves an answer's option reference against a request's options. Matches on
 * the stable `id`, or case-insensitively on `alias` or `label`.
 */
export function findOption(
  req: TurnsInputRequest,
  s: string,
): TurnsInputOption | null {
  if (s === "") return null;
  const ls = s.toLowerCase();
  for (const o of req.options ?? []) {
    if (
      o.id === s ||
      o.alias.toLowerCase() === ls ||
      o.label.toLowerCase() === ls
    )
      return o;
  }
  return null;
}

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
export function answerKeys(
  req: TurnsInputRequest,
  ans: InputAnswer,
): Uint8Array[] {
  const ids =
    ans.optionIDs && ans.optionIDs.length > 0
      ? ans.optionIDs
      : ans.optionID
        ? [ans.optionID]
        : [];
  if (req.multiSelect && req.submitKeys) {
    const chosen = ids.map((s) => findOption(req, s));
    if (ids.length === 0 || chosen.some((o) => o === null))
      throw ErrUnknownOption;
    const out = chosen.map((o) => o!.keys);
    out.push(req.submitKeys);
    return out;
  }
  if (ids.length > 1) throw ErrNotMultiSelect;
  const opt = findOption(req, ids[0] ?? "");
  if (!opt) throw ErrUnknownOption;
  return [opt.keys];
}
