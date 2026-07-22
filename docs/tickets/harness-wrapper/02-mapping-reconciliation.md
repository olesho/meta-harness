# Permission-rung mapping reconciliation — codex `manual`, codex `plan`, and the two-axis replay

**Workspace:** `harness-wrapper` · **Type:** task · **Priority:** 1
**Repo:** `harness-wrapper`. Line numbers verified against `117c0b1`.

> **Lands in ONE commit with Ticket 1 (guard sets) and Ticket 3 (wire-contract text).**
> Sub-part **2b without 2d is an active fail-open** — a `manual` launch would replay as `ask` and
> that wrong rung would go out on the wire. Do not land 2b alone under any circumstance.

## The governing rule (same as Ticket 1 — restated so this ticket stands alone)

**A guard entry is a three-site change.** Anything that suppresses injection must (i) enter the
injection guard in `argsWithHarnessPermissionMode` (`pkg/wrapper/wrapper.go:598`), (ii) enter the
matching arm of `EffectiveLaunchRung` (`:775`) — resolving to a rung when argv *proves* one, `""`
when it does not — and (iii) get corpus rows (Ticket 4). Skipping (ii) turns the guard into a
fail-open on `StructuredTurnResult.permission_mode`: injection stops, the knob arm still answers
from `Config.PermissionMode`, and the wire reports a rung the launch never had.

The same rule governs a **mapping** change: any edit to `codexPermissionMode` (`:674`, the forward
map) must be matched in `codexSandboxRung` / `codexRung` (`:833` / `:824`, the reverse map), or the
two disagree and the disagreement is published.

---

## 2b — codex `manual` becomes `-s workspace-write -a untrusted`

**Today** (`codexPermissionMode`, `wrapper.go:674-693`):

```go
case permissionModeManual:
    return codexSandboxReadOnly, "untrusted"
```

**Change to:** `codexSandboxWorkspaceWrite, "untrusted"`.

**Rationale.** claude's `manual` permits writes *after approval*; `read-only` forbids them
outright. Emitting `read-only` for `manual` makes the codex `manual` rung strictly more
restrictive than the same rung on claude, which is a cross-harness semantic divergence on a
canonical (harness-independent) rung. The canonical mapping is right about the semantics;
`workspace-write` + `untrusted` is the codex spelling of "writes allowed, every action gated".

**Record this as a deliberate loosening** of the codex `manual` rung in the commit message and in
`argsWithHarnessPermissionMode`'s mapping table (`:576-583`), so it is visible rather than
inferred by a future reader diffing the table.

`pkg/wrapper/permission_mode_test.go`'s `"codex manual"` row (`:100-106`) flips with it:

```go
want: []string{"-s", "workspace-write", "-a", "untrusted", "exec", "--json"}
```

Also check `"codex manual ahead of the resume subcommand"` (`:137`), which asserts the same
prefix ahead of `resume`.

---

## 2c — codex accepts `plan`, emits `-s read-only -a untrusted`, replays as `manual`

**Today** `validatePermissionMode` (`wrapper.go:359`) rejects it at `:367-372`:

```go
if normHarness(cfg.Harness) == "codex" && mode == permissionModePlan {
    return fmt.Errorf("%w: permission mode %q is not supported by the codex harness (no launch-time flag; use /plan after launch)", ErrInvalidConfig, mode)
}
```

**Change:**

1. Remove that rejection arm (`:367-372`).
2. `permission_mode_test.go:98-99` — the comment *"`plan` is absent on purpose: it is REJECTED by
   validateConfig for codex"* — is deleted and replaced by a `"codex plan"` row asserting
   `[]string{"-s", "read-only", "-a", "untrusted", …}`.
3. Remove the codex-`plan` reject row `{name: "plan on codex", harness: "codex", mode: "plan"}`
   from `TestValidateConfig_PermissionMode` (`permission_mode_test.go:477`, row at `:490`), and
   the `wantPlan` message assertion in `TestValidateConfig_PermissionModeMessages` (`:605`,
   const at `:609`).
4. `codexPermissionMode` gains `case permissionModePlan: return codexSandboxReadOnly, "untrusted"`.
5. **`codexRung` (`:824-829`) must stop passing `plan` through for codex.** Today it returns
   `"plan"` because `rungIndex("plan") >= 0` short-circuits before `codexSandboxRung`. After (4),
   a codex turn requested as `plan` launches `-s read-only -a untrusted`, which the argv arm
   resolves to `manual`; if the knob arm still answered `plan`, the two arms of
   `EffectiveLaunchRung` would disagree about one launch and
   `TestEffectiveLaunchRungIdempotentOverInjection` (`permission_rungs_test.go:202-228`) would
   fail — the documented idempotency invariant at `wrapper.go:769-774`.

**The replay reports `manual`, never `plan`. That is the point, not a defect.**

**Rationale — put this in the doc comment.** `read-only` + `untrusted` is strictly *more*
restrictive than every other rung, so accepting `plan` is not a fail-open in any direction. The
genuine defect being fixed is different: the *name* `plan` promises a property (no execution) that
launch argv cannot deliver on codex, because that property lives on a different axis. Cite
`pkg/turns/harness/codex/codex.go`'s `(*Adapter).PermissionMode` doc comment (`:167-189`),
asymmetry (1) at `:176-182`, verbatim:

> *"Different axes: the launch flag names a permissions RUNG, while codex's shift+tab-cycled Plan
> is a COLLABORATION mode reachable only from inside a running session. Neither value is
> expressible in the other's vocabulary."*

So: the rung is honoured as far as a launch flag can honour it, and the honesty about the
collaboration axis is **deferred to the detector on that axis** — see Ticket 3 for the
known-wrong seam in that detector today.

---

## 2d — the replay must read BOTH codex axes (the hazard 2b introduces)

**This is not optional and not deferrable. It is the same commit.**

After 2b, `manual` and `ask` both emit `-s workspace-write`. `EffectiveLaunchRung`'s codex arm
(`wrapper.go:786-797`) reads **only** the `-s` axis:

```go
if value, ok := flagValue(args, "-s", "--sandbox"); ok {
    return codexSandboxRung(value)
}
```

and `codexSandboxRung` (`:833-843`) maps `workspace-write → ask`. Unfixed, a `manual` launch
replays as **`ask`**, `MorePermissive("ask", "manual")` (`:712`) returns **true**, and since
HW-101 that wrong, more-permissive rung goes out on the wire. That is precisely the fail-open this
work exists to close, introduced by the work itself.

### The seven-step ordered resolution rule (codex arm)

Evaluate in order; the first step that fires wins.

1. **`codexBypassFlag` present** (any spelling `argsContainAnyFlag` recognizes) → `bypass`.
   Proof of unrestricted; nothing later may downgrade it.
2. **`configKeyValue(args, "sandbox_mode")` == `danger-full-access`** (Ticket 1's helper; quotes
   stripped) → `bypass`. Same proof, spelled through `-c`. This step is what keeps the
   protocol-doc "presence of bypass is trustworthy" guarantee true for the `-c` spelling.
3. **`-p` / `--profile` present** → `""`. The posture lives in a TOML file the wrapper does not
   read. **Unconditional** — it fires even when `-s` is also present, because a flag beats the
   profile only on the axis it sets and the profile still supplies every axis left unset, so the
   real pair can be one that is nowhere in the forward map (`(read-only, never)` — see Ticket 1's
   `codex debug prompt-input` evidence table). Ordered **after** steps 1–2 so that proof of
   unrestricted still wins.
4. **Resolve the sandbox axis.** `flagValue(args, "-s", "--sandbox")` (`:863`, last-wins); if
   absent, `configKeyValue(args, "sandbox_mode")`. If neither is present, go to step 6.
5. **Resolve the approval axis.** `flagValue(args, "-a", "--ask-for-approval")`; if absent,
   `configKeyValue(args, "approval_policy")`. Then resolve the **pair** through the inverse of
   `codexPermissionMode`'s post-2b/2c forward map:

   | sandbox | approval | rung |
   |---|---|---|
   | `read-only` | `untrusted` | `manual` (also the `plan` launch shape — reported as `manual`) |
   | `workspace-write` | `untrusted` | `manual` |
   | `workspace-write` | `on-request` | `ask` |
   | `workspace-write` | `never` | `auto` |
   | `danger-full-access` | `never` | `bypass` |
   | any other pair | | fall through to the **single-axis ceiling** of the sandbox value (step 6) |

   An **absent** approval axis is not "any other pair" — it is the single-axis case, step 6.
6. **Single-axis ceiling.** A sandbox value with no approval value resolves to the **most
   permissive rung that shares that sandbox value**:

   | `-s` value (no `-a`) | ceiling rung | why |
   |---|---|---|
   | `read-only` | `manual` | the only rung emitting `read-only` post-2c |
   | `workspace-write` | **`auto`** | shared by `manual`, `ask` and `auto`; the launch left `-a` at codex's default, so the *ceiling* is the only answer that cannot under-report |
   | `danger-full-access` | `bypass` | the only rung emitting it |
   | anything else | `""` | unknown |

   Ceiling, not floor: under-reporting permissiveness is the one direction a safety field must
   never fail in (same rationale already written into `flagValue`'s doc at `:852-857`).
7. **No sandbox value but an approval-axis suppressor present** (`-a` / `--ask-for-approval`, or
   `approval_policy` via `-c`) → `""`. Whole-directive suppression fired with no sandbox value to
   read; the sandbox stayed at codex's default, which the wrapper does not model. (This is the
   existing `:793-796` behaviour, preserved.)

   Otherwise fall through to the knob: `codexRung(mode)` (`:824`).

### The ceiling goes **inside `codexSandboxRung`**, not only in `EffectiveLaunchRung`'s arm

Two reasons, both load-bearing:

- `isSupportedPermissionMode` (`:560`, codex arm at `:571-575`) accepts `workspace-write` as a
  **mode**, and the single-axis knob `PermissionMode: "workspace-write"` produces the identical
  posture a bare `-s workspace-write` produces (`codexPermissionMode`'s default arm returns
  `(mode, "")`, so `argsWithHarnessPermissionMode:653-656` emits `-s workspace-write` and nothing
  else). **One posture must not get two answers.**
- An argv-only change breaks `TestEffectiveLaunchRungIdempotentOverInjection`
  (`permission_rungs_test.go:202-228`) for `{"codex", nil, "workspace-write"}` — the knob arm
  would say `ask` and the post-injection argv arm would say `auto`.

## Consequences to enumerate in the ticket / commit message — all deliberate, all same commit

**Two frozen rows flip — this is a user-visible replay change on the wire:**

- `permission_rungs_test.go:137` — `{"codex knob native workspace-write", "codex", nil, "workspace-write"}`: `ask` → **`auto`**
- `permission_rungs_test.go:130` — `{"codex argv attached short workspace-write", "codex", []string{"-sworkspace-write"}, ""}`: `ask` → **`auto`**

**Rows that do NOT move** (assert they still pass unchanged — they are the regression fence):

- `:129` `{"codex argv attached long read-only", []string{"--sandbox=read-only"}}` → `manual`
- `:148` `{"codex argv sandbox wins over approval axis", []string{"-sworkspace-write", "-aon-request"}}` → `ask`
- `:144` `{"codex argv short attached-equals danger-full-access", []string{"-s=danger-full-access"}}` → `bypass`
- `:150` `{"codex argv duplicate sandbox last wins", []string{"-s","read-only","-s","danger-full-access"}}` → `bypass`
- `:136` `{"codex knob manual", nil, "manual"}` → `manual`

**Test-side work:**

- Add `{"codex", nil, "workspace-write"}` to `TestEffectiveLaunchRungIdempotentOverInjection`
  (`:202-228`).
- **Rewrite `codexSandboxRung`'s doc comment** (`:831-832`). *"the inverse of
  `codexPermissionMode`'s sandbox half"* stops being true: post-2b the sandbox half is no longer
  invertible on its own, and the function now reports the **ceiling** among the rungs sharing that
  value.
- **Fix `TestEffectiveLaunchRungMatchesInjection`** (`:167-199`). Its test-local mirror computes
  the codex expectation as `codexSandboxRung(flagValue(out, "-s", "--sandbox"))` — a single-axis
  read. It must become the two-axis helper, or it asserts the old contract against the new code
  and passes for the wrong reason (or fails for a reason that looks like a product bug).
- Add codex rows exercising every step of the seven-step rule, including step 3's
  `-s read-only -p wide` → `""` and step 2's `-c sandbox_mode="danger-full-access"` → `bypass`.

## Acceptance

- [ ] 2b, 2c, 2d and Tickets 1 and 3 land in **one commit**.
- [ ] `codexPermissionMode` emits `-s workspace-write -a untrusted` for `manual` and
      `-s read-only -a untrusted` for `plan`.
- [ ] `validatePermissionMode` no longer rejects codex + `plan`; both message tests updated.
- [ ] `codexRung` no longer passes `plan` through on codex.
- [ ] The seven-step rule is implemented in `EffectiveLaunchRung`'s codex arm and written into its
      doc comment; the single-axis ceiling lives inside `codexSandboxRung`.
- [ ] `permission_rungs_test.go:130` and `:137` flipped to `auto`; the five listed
      non-moving rows still pass unchanged.
- [ ] `TestEffectiveLaunchRungMatchesInjection`'s local mirror is two-axis.
- [ ] `TestEffectiveLaunchRungIdempotentOverInjection` gains `{"codex", nil, "workspace-write"}`.
- [ ] `go test ./...` green; `MorePermissive(EffectiveLaunchRung(codex, manualArgv, ""), "manual")`
      is false (i.e. `manual` no longer replays as something more permissive).
