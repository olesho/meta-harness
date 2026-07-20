# Hook environment variables

The `HW_*` env vars are the contract between an orchestrator and the
out-of-process hook handler: the orchestrator SETS them in the harness launch
env, and the hook handler (the Go `harness hook` bin in harness-wrapper, or the
`meta-harness-hooks` bin here) READS them when the harness fires a hook. This
table is the source of truth for that surface across both implementations —
support is recorded per side because the two are not fully symmetric.

Within meta-harness the variables are exported as constants:
`EnvSpool` / `EnvHookCwd` / `EnvHome` / `EnvYieldFile` from
`src/acquisition/internal/yield.ts`, and `EnvConfigDir` /
`EnvConfigDirDeprecated` / `EnvSessionID` from `src/cli/hooks.ts`.

## Variables

| Variable                 | Purpose                                                                                                              | Go (harness-wrapper) | TS (meta-harness) |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------- |
| `HW_EVENT_SPOOL`         | Spool directory the hook handler appends canonical events to. Absent or empty ⇒ the handler is inert.                | ✅                   | ✅                |
| `HW_HOOK_CWD`            | The harness working dir (worktree) the hook fired from; used for transcript-path validation.                         | ✅                   | ✅                |
| `HW_HOME`                | User home dir; fallback base for deriving the harness config dir.                                                    | ✅                   | ✅                |
| `HW_YIELD_FILE`          | Yield file the yield-guard PreToolUse hook checks before each tool. Wired differently per side (see note below).     | ✅                   | ✅                |
| `HW_HARNESS_CONFIG_DIR`  | Overrides the harness config dir (e.g. where `settings.json` lives). Empty ⇒ derived from `HW_HOME`.                 | ✅                   | ✅                |
| `HW_CONFIG_DIR`          | **Deprecated** old TS-only spelling of `HW_HARNESS_CONFIG_DIR`; read only when the canonical var is unset or empty. Removed in the next minor release. | —                    | ⚠️ deprecated     |
| `HW_HARNESS_SESSION_ID`  | Expected harness session id for the session-mismatch guard (a stray hook from another session is dropped). Empty ⇒ no expectation. | —                    | ✅                |

Known asymmetries, recorded rather than papered over:

- `HW_HARNESS_SESSION_ID` exists only in the TS implementation — it feeds the
  session-mismatch guard; the Go side has no counterpart.
- Yield-guard handling is wired differently per side: both read
  `HW_YIELD_FILE`, but the hook that consumes it is installed and drained
  through each implementation's own runtime.

## Config-dir precedence (TS)

The TS hook CLI resolves `configDir` as: a **non-empty** `HW_HARNESS_CONFIG_DIR`
wins; unset or empty falls through to `HW_CONFIG_DIR`; both absent or empty ⇒
`""`, which the provider treats as "derive from `HW_HOME`"
(`<home>/.claude/settings.json`).

## Transition guidance

`HW_CONFIG_DIR` is deprecated in favor of the canonical
`HW_HARNESS_CONFIG_DIR` (the spelling the Go implementation already uses).
Orchestrators driving both implementations should export **both** names for one
release — meta-harness's own launcher does exactly this
(`src/chat/conversation.ts`). This is the only mitigation for the uncoverable
skew case where a new orchestrator exporting only `HW_HARNESS_CONFIG_DIR` runs
against an old installed `meta-harness-hooks` bin, which would otherwise
silently fall back to the default config dir. The deprecated row above, the
`EnvConfigDirDeprecated` constant, and the compatibility launch-env line are
removed together in the next minor release.
