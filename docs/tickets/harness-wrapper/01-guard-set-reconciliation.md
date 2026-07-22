# Permission-argv guard-set reconciliation — three missing suppressors, three sites each

**Workspace:** `harness-wrapper` · **Type:** task · **Priority:** 1
**Repo:** `harness-wrapper`, all paths relative to its root. Line numbers verified against `117c0b1`.

> **Lands in ONE commit with Ticket 2 (mapping reconciliation) and Ticket 3 (wire-contract text).**
> A guard row without its replay half is the same fail-open this whole body of work exists to
> close, just relocated. Do not split.

## The governing rule — read this before touching anything

**A guard entry is a three-site change.** Anything that suppresses permission-mode injection must:

1. enter the injection guard in `argsWithHarnessPermissionMode` (`pkg/wrapper/wrapper.go:598`;
   claude guard at `:612`, codex guard at `:624`);
2. enter the matching arm of `EffectiveLaunchRung` (`:775`; claude arm `:777-785`, codex arm
   `:786-797`) — resolving to a **rung** when argv _proves_ one, and to `""` when it does not;
3. get rows in the argv conformance corpus (Ticket 4).

Skipping (2) converts a guard into a **fail-open on `StructuredTurnResult.permission_mode`**:
injection stops, but the knob arm still answers from `Config.PermissionMode`, so the wire reports
a rung the launch never had. Since HARNESS-WRAPPER-101 that value is published
(`pkg/turnproto/protocol.go:105-157`), so a knob-only answer is a user-visible lie, not an
internal detail.

## Background (self-contained — you do not need to have read META-HARNESS-132)

`wrapper.Config.PermissionMode` is a canonical rung (`plan | manual | ask | auto | bypass`,
`pkg/wrapper/wrapper.go:694` `PermissionRungs`). At launch, `argsWithHarnessPermissionMode`
prepends the harness-native spelling of that rung — unless argv already carries a token on the
same axis, in which case it injects **nothing** and leaves the caller's argv exactly as written
("whole-directive wins", see the comment at `:620-623`).

`EffectiveLaunchRung` is the **replay** of that decision: it reports the rung the harness actually
launched at, reading argv first and only falling back to the knob. It is what
`StructuredTurnResult.permission_mode` carries.

The two sets have drifted. Three suppression cases exist in reality but are missing from one or
both sides.

## The three rows

| #   | Divergence                                       | Go today                                                                                                                                 | Fix                                                                                                                                                                                      |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | codex `-p` / `--profile`                         | absent from the codex guard — `grep -n profile pkg/wrapper/*.go` returns nothing                                                         | guard (`wrapper.go:624`) **+** replay rule → `""` **+** corpus rows including `-pwide` and `--profile=wide`                                                                              |
| b   | codex `-c sandbox_mode=` / `-c approval_policy=` | absent from the codex guard **and** from the replay                                                                                      | guard via `argsContainConfigKey` (`:936`) **+** replay rules (`sandbox_mode` == `danger-full-access` → `bypass` through a new `configKeyValue` helper; otherwise `""`) **+** corpus rows |
| c   | claude `--allow-dangerously-skip-permissions`    | absent from the claude guard (`:612`), from `BypassEnablingFlags` (`:739`), **and** from `EffectiveLaunchRung`'s claude arm (`:777-785`) | all three sites                                                                                                                                                                          |

## The new helper: `configKeyValue(args []string, key string) (string, bool)`

Required because `configArgHasKey` (`wrapper.go:954`) matches the **key only** —
`arg == key || strings.HasPrefix(arg, key+"=")` — and `argsContainConfigKey` (`:936`) answers
presence, never the value. Row (b) needs the value to decide `bypass` vs `""`.

Requirements:

- Mirror `argsContainConfigKey`'s **four spellings** exactly: `-c k=v`, `-ck=v`, `--config k=v`,
  `--config=k=v`. Do not invent a fifth and do not drop one.
- **Last-wins**, like `flagValue` (`:863`) — same rationale, spelled out in `flagValue`'s doc
  comment at `:852-857`: clap is last-wins, so reporting the earlier value under-reports
  permissiveness, the one direction a safety field must never fail in.
- **Strip one matched pair of surrounding `"` or `'`.** This is not cosmetic: the wrapper's own
  emitted form is `key="value"` (`prependArgs(args, "-c", "model_reasoning_effort=\""+…+"\"")` at
  `wrapper.go:443`, and `"model=\""+model+"\""` at `:473`), so an un-stripped read of
  `sandbox_mode="danger-full-access"` compares against the literal
  `"danger-full-access"` _with quotes_ and never matches the sandbox constant
  (`codexSandboxDangerFullAccess`, declared near `:538`). Strip exactly one matched pair —
  `"a"b"` is not a shell, do not try to be one.
- Return `("", false)` when the key is absent; `("", true)` when present but unreadable (trailing
  `-c` with no operand), matching `flagValue`'s documented `ok`-means-PRESENCE contract at
  `:859-862`.

## Row (c) is live-verified and flips two frozen tests

`claude --help` at **2.1.217** lists **both**:

- `--allow-dangerously-skip-permissions` — "Enable bypassing all permission checks"
- `--dangerously-skip-permissions`

Today, `Args: ["--allow-dangerously-skip-permissions"]` + `PermissionMode: "plan"`:

1. passes `validatePermissionMode`'s contradiction check (`:359`, contradiction arm sourced from
   `BypassEnablingFlags` at `:739`) with **no error**;
2. is not seen by the claude injection guard at `:612`, so `--permission-mode plan` is prepended
   anyway;
3. is reported by `EffectiveLaunchRung` (`:777-785`) as `plan`, when **bypass is in fact
   reachable** — and since HW-101 that lands on the wire.

**Two frozen tests flip, not one.**

- `TestBypassEnablingFlags` (`pkg/wrapper/permission_rungs_test.go:58-79`) asserts the exact
  per-harness slices.
- `TestBypassEnablingFlagsNeverIncludesNonexistentFlag` (`:81-90`) asserts the returned flags are
  only `SkipPermissionsFlag` / `codexBypassFlag`, with the comment at `:82`:
  _"--allow-dangerously-skip-permissions does not exist in this repo."_

Adding the flag to the **injection guard** alone trips neither. Adding it to
**`BypassEnablingFlags`** trips both. **That comment is factually wrong at claude 2.1.217 and must
be rewritten citing the `claude --help` probe** — not worked around, not deleted silently, and not
routed around by leaving `BypassEnablingFlags` untouched.

Also update **`suppressionFlagsFor`** (`permission_rungs_test.go:262-273`, func at `:264`), a
hand-copied mirror of the guard set. It gains `-p` / `--profile` on the codex arm and
`--allow-dangerously-skip-permissions` on the claude arm. (The `-c` keys of row (b) are **not
flags** — `argsContainAnyFlag` will never see them — so they need their own mirror arm in that
helper, or the row-(b) corpus/replay cases will not satisfy the setup assertion.) Without this,
`TestEffectiveLaunchRungResolvesFromArgvWhenSuppressed`'s setup assertion
(`permission_rungs_test.go:249-252`, `t.Fatalf("test setup: %v does not trip suppression …")`)
fails on the new rows.

### Blast radius, stated honestly

`BypassEnablingFlags` has **no non-test callers** today — its doc comment's _"pkg/chat's
ring-length calculation"_ (`:733-734`) is aspirational, not current. So the only production
consequence of row (c) is that `--allow-dangerously-skip-permissions` paired with a non-bypass
rung becomes a hard `ErrInvalidConfig`. That is the intended fail-closed direction, but it **is a
new rejection** for argv that is accepted today. Call it out in the commit message.

## Two hazards to carry into the docstrings

**H1 — `-p` prefix-matches on codex.** `argsContainAnyFlag` (`:915-927`) matches an attached short
form by **prefix**: `isShortFlag(flag) && len(arg) > 2 && strings.HasPrefix(arg, flag)` (`:921`),
and `isShortFlag("-p")` (`:932`) is true. So on **codex**, any single-dash token longer than two
characters beginning with `-p` suppresses injection silently. This is **accepted** — it is the
same one-sided direction already documented for `-s` / `-a` at `:909-914` (a false positive
suppresses injection and leaves argv exactly as written, rather than emitting a duplicate flag) —
but it **must be called out** in the docstring next to the existing note, not left to be
rediscovered.

**H2 — the guard sets are strictly per-harness.** On **claude**, `-p` is `--print`.
`pkg/wrapper/permission_mode_test.go:82-88` already freezes:

```go
{ name: "claude-code auto", harness: "claude-code", args: []string{"-p"}, mode: "auto",
  want: []string{"--permission-mode", "auto", "-p"} }
```

A `-p` entry leaking into the **claude** list would silently stop injecting the permission mode
for every `--print` invocation — the single most common claude shape in this repo. The claude and
codex arms of the guard, of `suppressionFlagsFor`, and of `EffectiveLaunchRung` must be edited
independently. Ticket 4 freezes a dedicated counter-row for exactly this.

## Why `-p` is _suppressed_ while a bypass flag is _rejected_

Put this paragraph in `EffectiveLaunchRung`'s doc comment (`wrapper.go:750-774`):

> **Reject when argv proves the launch would be unrestricted; suppress-and-report-`""` when argv
> makes the launch posture unknowable.**

`--dangerously-bypass-approvals-and-sandbox` is **proof** — pairing it with a restrictive rung is a
contradiction, so `validatePermissionMode` rejects. `-p wide` proves **nothing**: the posture lives
in a TOML file the wrapper does not read, so there is no proposition to contradict, and the honest
answer is `""` (UNKNOWN, never "default" — see the existing `:762-767`).

**Evidence** — `codex debug prompt-input` with `CODEX_HOME` holding `wide.config.toml`
(`sandbox_mode = "danger-full-access"`, `approval_policy = "never"`), codex-cli **0.144.5**:

| argv                                                 | resolved sandbox     | resolved approval |
| ---------------------------------------------------- | -------------------- | ----------------- |
| `-p wide`                                            | `danger-full-access` | `never`           |
| `-s read-only -p wide`                               | `read-only`          | `never`           |
| `-p wide -s read-only`                               | `read-only`          | `never`           |
| `-c sandbox_mode="read-only" -p wide` (either order) | `read-only`          | `never`           |
| `-s read-only -a untrusted -p wide`                  | `read-only`          | not `never`       |

**A flag or `-c` override beats the profile on the axis it sets, in either order — but the profile
still supplies every axis you leave unset.**

That is why the `-p` rule is **unconditional**, not scoped to "`-p` and no `-s`". With
`-s read-only -p wide` the real posture is `(read-only, never)`, which is **nowhere in
`codexPermissionMode`'s forward map** (`wrapper.go:674-693`); naming it `manual` (the rung
`codexSandboxRung` gives `read-only`) would under-report the approval axis. `""` is the only
honest answer.

Ordering note for the replay: the **bypass-proof** rules run **before** the `-p` unknown rule, so
`-c sandbox_mode="danger-full-access" -p wide` still reports `bypass`. See Ticket 2's seven-step
ordered rule, which is where the final ordering is specified.

## Acceptance

- [ ] Codex injection guard at `wrapper.go:624` covers `-p`, `--profile`, and (via
      `argsContainConfigKey`) the `sandbox_mode` and `approval_policy` config keys.
- [ ] Claude injection guard at `:612` covers `--allow-dangerously-skip-permissions`.
- [ ] `BypassEnablingFlags` (`:739`) returns `--allow-dangerously-skip-permissions` for claude /
      claude-code, and `EffectiveLaunchRung`'s claude arm (`:777-785`) treats it as a definite
      `bypass` exactly as it treats `SkipPermissionsFlag`.
- [ ] `configKeyValue` exists, mirrors all four `-c` spellings, is last-wins, strips one matched
      quote pair, and is unit-tested for each spelling plus the quoted/unquoted pair.
- [ ] `EffectiveLaunchRung`'s codex arm returns `""` for `-p`/`--profile` and for a
      non-`danger-full-access` `sandbox_mode`, and `bypass` for
      `sandbox_mode` == `danger-full-access` in every spelling.
- [ ] `permission_rungs_test.go:58-79` and `:81-90` updated; the `:82` comment **rewritten** to
      cite the `claude --help` 2.1.217 probe.
- [ ] `suppressionFlagsFor` (`:264`) mirrors the new per-harness sets, including a config-key arm.
- [ ] H1 documented in `argsContainAnyFlag`'s comment; the reject-vs-suppress rule documented in
      `EffectiveLaunchRung`'s comment.
- [ ] Same commit as Ticket 2 and Ticket 3.
