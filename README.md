# meta-harness

TypeScript project wired to [Orche](../../new/orche) for autonomous plan → ship → release → redeploy.

## Develop

```bash
bun install
bun test        # the release gate (ORCHE_RELEASE_GATE_CMD)
```

## Session resume

A conversation can be relaunched against a harness that supports resuming a prior
session (currently `claude-code` and `codex`). Two entry points, both in
`src/chat`:

- `Open(ctx, { ..., resume })` — low level. `resume` names the *harness* session
  id (not the chat session id). The resolved adapter's resume args are prepended
  to `args` at launch and the new chat session's `harnessSessionID` is seeded.
  Throws `ErrResumeUnsupported` when the harness has no resume sequence.
- `Reopen(ctx, opts)` — convenience. Loads a stored chat `Session` by
  `opts.sessionID`, derives `harness`/`workingDir` from the record and the resume
  id from its `harnessSessionID`, and relaunches reusing the **same** chat session
  id so `sessionID()` and history reflect the resumed session.

The stored `Session` persists only `harness`, `workingDir`, and
`harnessSessionID`. All other launch knobs (`binaryPath`, `env`, `args`, `effort`,
`model`, `cols`/`rows`, input policy, …) must still be supplied by the caller via
`ReopenOptions`. `Reopen` throws `ErrNoHarnessSession` when the stored session
never captured a harness session id, and surfaces `ErrResumeUnsupported` when its
harness cannot resume.

## Orche

This project is wired to the `META-HARNESS` fleet-db workspace via the
`autonomous-dev-deploy` pipeline. See `.orche/config.json` and `.env`. Ship a plan
from Claude Code with "ship this plan", or check agents with "are the agents running?".
