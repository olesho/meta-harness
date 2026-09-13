# Permission-argv guard-set reconciliation — two missing suppressors (three sites each) plus one reachability-only flag

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

The two sets have drifted. Two suppression cases exist in reality but are missing from one or
both sides. A third flag, row (c), looks like a suppressor but is not one: it only makes the bypass
rung reachable, so it belongs in the ring-length answer and nowhere else.

## The three rows

| #   | Divergence                                       | Go today                                                                                                                                                                                                                  | Fix                                                                                                                                                                                                             |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | codex `-p` / `--profile`                         | absent from the codex guard — `grep -n profile pkg/wrapper/*.go` returns nothing                                                                                                                                          | guard (`wrapper.go:624`) **+** replay rule → `""` **+** corpus rows including `-pwide` and `--profile=wide`                                                                                                     |
| b   | codex `-c sandbox_mode=` / `-c approval_policy=` | absent from the codex guard **and** from the replay                                                                                                                                                                       | guard via `argsContainConfigKey` (`:936`) **+** replay rules (`sandbox_mode` == `danger-full-access` → `bypass` through a new `configKeyValue` helper; otherwise `""`) **+** corpus rows                        |
| c   | claude `--allow-dangerously-skip-permissions`    | absent from the claude guard (`:612`), from `BypassEnablingFlags` (`:739`) and from `EffectiveLaunchRung`'s claude arm (`:777-785`), **which is correct**; also absent from `pkg/chat`'s ring-length answer, which is not | **reachability only**: a separate `BypassReachableFlags` feeding `cycleRing`. The guard, `BypassEnablingFlags` and `EffectiveLaunchRung` stay as they are. Landed as harness-wrapper PR #48 (`loom/PUPPET-496`) |

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

## Row (c): the flag UNLOCKS the bypass rung, it does not ENABLE bypass

`claude --help` lists **both** flags (verified at **2.1.217**; the full descriptions below were
re-read at **2.1.270**), and it describes them **differently**:

- `--allow-dangerously-skip-permissions` — "Enable bypassing all permission checks as an option,
  without it being enabled by default. Recommended only for sandboxes with no internet access."
- `--dangerously-skip-permissions` — "Bypass all permission checks. Recommended only for sandboxes
  with no internet access."

An earlier revision of this ticket quoted only the first five words of the first description,
read the two flags as synonyms, and asked for the unlock flag in all three sites. **That reading
was wrong.** The flag puts the bypass rung **on** the Shift+Tab ring without **selecting** it:
harness-wrapper PR #48 measured a launch carrying it landing in auto mode, not bypass, with
Shift+Tab reaching "bypass permissions" on a 5-rung cycle. For `Args: ["--allow-dangerously-skip-permissions"]`
plus `PermissionMode: "plan"`, Go before that PR (`d6eb85f`) was right on three counts and wrong on
one:

1. `validatePermissionMode`'s contradiction check (`:359`, sourced from `BypassEnablingFlags` at
   `:739`) accepts it. **Correct**: a restrictive mode is exactly the pairing the unlock flag
   exists for. Putting the flag in `BypassEnablingFlags` would turn that config into a hard
   `ErrInvalidConfig`.
2. The claude injection guard at `:612` does not see it, so `--permission-mode plan` is prepended.
   **Correct**: the flag sets no rung, and suppressing injection would drop the caller's `plan`
   and launch at claude's own default.
3. `EffectiveLaunchRung` (`:777-785`) reports `plan`. **Correct**: the session launches in plan,
   and reporting `bypass` would put an unrestricted posture on the wire for a restricted launch.
4. `pkg/chat`'s `cycleRing` built a 4-ring, so `SetPermissionMode("bypass")` fast-failed with
   `ErrPermissionModeUnreachable`. **Wrong**: bypass is reachable. This is the only place the flag
   is missing.

So row (c) is **not** a guard entry and the three-site rule does not apply to it. The fix is a
separate `BypassReachableFlags` (the `BypassEnablingFlags` flags plus
`--allow-dangerously-skip-permissions` for claude / claude-code; the same as
`BypassEnablingFlags` for codex) that feeds `cycleRing` and nothing else. harness-wrapper PR #48
(`loom/PUPPET-496`) lands it.

**No frozen test flips.** `TestBypassEnablingFlags` (`pkg/wrapper/permission_rungs_test.go:58-79`)
and `TestBypassEnablingFlagsNeverIncludesNonexistentFlag` (`:81-90`) keep their assertions. Only
the comment at `:82`, _"--allow-dangerously-skip-permissions does not exist in this repo."_, is
rewritten: the flag does exist upstream, but it is unlock-only, which is why it must stay out of
that set.

Also update **`suppressionFlagsFor`** (`permission_rungs_test.go:262-273`, func at `:264`), a
hand-copied mirror of the guard set. It gains `-p` / `--profile` on the codex arm. It must **not**
gain `--allow-dangerously-skip-permissions` on the claude arm, because the guard does not have it
either. (The `-c` keys of row (b) are **not flags** — `argsContainAnyFlag` will never see them — so
they need their own mirror arm in that helper, or the row-(b) corpus/replay cases will not satisfy
the setup assertion.) Without this, `TestEffectiveLaunchRungResolvesFromArgvWhenSuppressed`'s setup
assertion (`permission_rungs_test.go:249-252`, `t.Fatalf("test setup: %v does not trip suppression …")`)
fails on the new rows.

### Blast radius, stated honestly

Row (c) changes one production answer: `cycleRing` puts bypass on the ring for a launch carrying
the unlock flag, so `SetPermissionMode("bypass")` stops fast-failing on it. Nothing new is rejected
and no argv changes. The earlier revision's plan would have made every
`--allow-dangerously-skip-permissions` + non-bypass-rung launch a hard `ErrInvalidConfig`,
dropped the injected rung, and reported `bypass` for a restricted session. All three would have
been regressions.

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
- [ ] Claude injection guard at `:612` does **not** cover `--allow-dangerously-skip-permissions`:
      the flag pins no rung, so `--permission-mode` is still injected alongside it.
- [ ] `BypassEnablingFlags` (`:739`) and `EffectiveLaunchRung`'s claude arm (`:777-785`) do **not**
      learn `--allow-dangerously-skip-permissions`: it is neither bypass-enabling nor a definite
      `bypass`. A separate `BypassReachableFlags` (`BypassEnablingFlags` plus the unlock flag for
      claude / claude-code) feeds `pkg/chat`'s `cycleRing` only — done in harness-wrapper PR #48.
- [ ] `configKeyValue` exists, mirrors all four `-c` spellings, is last-wins, strips one matched
      quote pair, and is unit-tested for each spelling plus the quoted/unquoted pair.
- [ ] `EffectiveLaunchRung`'s codex arm returns `""` for `-p`/`--profile` and for a
      non-`danger-full-access` `sandbox_mode`, and `bypass` for
      `sandbox_mode` == `danger-full-access` in every spelling.
- [ ] `permission_rungs_test.go:58-79` and `:81-90` keep their assertions; the `:82` comment is
      **rewritten** to cite the full `claude --help` description (the flag exists, unlock-only).
- [ ] `suppressionFlagsFor` (`:264`) mirrors the new per-harness sets, including a config-key arm,
      and has no `--allow-dangerously-skip-permissions` entry.
- [ ] H1 documented in `argsContainAnyFlag`'s comment; the reject-vs-suppress rule documented in
      `EffectiveLaunchRung`'s comment.
- [ ] Same commit as Ticket 2 and Ticket 3.
