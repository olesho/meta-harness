// Transcript error sentinels. Readers throw a CausedError (via wrap) whose
// cause chain carries one of these stable sentinels; callers and tests assert
// membership with isSentinel(err, sentinel) — the analogue of Go's errors.Is.

import { defineSentinel } from "../internal/async/index.ts"

// A requested session id was empty.
export const ErrEmptySessionID = defineSentinel(
  "transcript/empty-session-id",
  "empty session id",
)

// A reader that requires a working directory was given none.
export const ErrEmptyWorkingDir = defineSentinel(
  "transcript/empty-working-dir",
  "empty working dir",
)

// No transcript file could be located for the requested session.
export const ErrSessionNotFound = defineSentinel(
  "transcript/session-not-found",
  "no session file found",
)
