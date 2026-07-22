# Permission-mode argv parity — the codex encoding decision (META-HARNESS-132)

**Status:** settled · 2026-07-22 · decided in META-HARNESS-132, recorded here so it is not
re-litigated
**Scope:** the argv encoding both implementations emit for `PermissionMode`, the guard sets that
suppress that emission, the replay that reports it back on the wire, and the version floor all of
it is stated against. No code lands with this note.
**Related:** META-HARNESS-99 (epic) · META-HARNESS-100 (the TS implementation, `blocked` and
amended by this decision) · META-HARNESS-102 (owns the version pin bump) ·
harness-wrapper `pkg/wrapper/wrapper.go` (`argsWithHarnessPermissionMode`, shipped) ·
`crossrepo/meta-harness/HARNESS-WRAPPER-77-permission-mode.md`,
`…-78-sandbox-defaults-argv.md`, `…-101-structured-result-permission-mode.md`.

---

## 1. The decision

**codex permission-mode argv is `-s <sandbox> [-a <policy>]`. It is not
`-c sandbox_mode="…" -c approval_policy="…"`.**

Go shipped the flag form first (`argsWithHarnessPermissionMode`, `pkg/wrapper/wrapper.go:598`),
with two arms: a **pair arm** for a canonical rung (`-s <sandbox> -a <policy>`) and a
**single-axis arm** for a codex-native sandbox value, where `codexPermissionMode` returns an empty
approval and only `-s` is emitted, leaving `-a` untouched. META-HARNESS-100 proposed the `-c` form
under its "A2" heading, on the strength of probes that have now been re-run and **inverted**. TS
matches what Go shipped; no encoding change lands in Go; MH-99's own epic table already spelled
the codex column `-s`/`-a`, so this restores the epic, MH-100 and Go to a single encoding instead
of two.

`-c sandbox_mode=` / `-c approval_policy=` remain documented — not as what we emit, but as the
**equivalent spelling a caller may pass verbatim**, which the guard recognises and which
suppresses injection. See §5.

## 2. Probe results

**Instrument: `codex doctor --json`, not `/status`.** `/status` is a TUI interaction and cannot be
automated into a test. `doctor --json` reports the _effective resolved_ values under
`checks["sandbox.helpers"].details` (`"approval policy"`, `"filesystem sandbox"`,
`"network sandbox"`) and exits non-interactively. Exit codes prove nothing here: codex accepts
unknown `-c` keys, and `--strict-config` does not catch them.

**Environment: codex-cli 0.144.5, claude-code 2.1.217, macOS. Every row executed 2026-07-22.**

| probe                                                                                       | approval policy | filesystem sandbox |
| ------------------------------------------------------------------------------------------- | --------------- | ------------------ |
| baseline                                                                                    | `OnRequest`     | restricted         |
| `-c sandbox_mode="read-only" -c approval_policy="untrusted"`                                | `UnlessTrusted` | restricted         |
| `-s danger-full-access -a never`                                                            | `Never`         | unrestricted       |
| `-s danger-full-access -a never -c sandbox_mode="read-only" -c approval_policy="untrusted"` | `Never`         | unrestricted       |

1. **Key names are correct.** `sandbox_mode` / `approval_policy` both take effect. The `-c` form is
   not broken — it is simply weaker.
2. **Flags beat `-c` unconditionally, in either order.** Reversing the order changes nothing.
3. **Repeated `-c` is silent last-wins; repeated `-s`/`-a` is a hard error.**
   `-c sandbox_mode="read-only" -c sandbox_mode="danger-full-access"` resolves to unrestricted,
   silently; `-s read-only -s danger-full-access` exits **2** with
   `error: the argument '--sandbox <SANDBOX_MODE>' cannot be used multiple times`.
4. **Subcommand position is not a differentiator.** `codex -s … -a … doctor --json` _applies_ the
   values ahead of a subcommand — stronger evidence than MH-100's exit-0 `--help` probe.
   `argsWithHarnessPermissionMode`'s comment already records this as "SETTLED, do not re-derive"
   (probed twice on 2026-07-22, including `codex -s workspace-write -a on-request resume --help`),
   and `resume` is the live subcommand path.
5. **Overriding the user's global config is not a differentiator either** — `-s`/`-a` also override
   `~/.codex/config.toml` (baseline `OnRequest` → `Never` in the third row above).

Of MH-100's four A2 reasons, 1 and 4 are refuted by findings 4 and 5; 3 (structural uniformity) is
cosmetic; 2 (guard and injection share a vocabulary) is real but achievable either way — **the
guard must cover both vocabularies regardless of which one is emitted.**

## 3. Why findings 2 and 3 decide it: fail-closed beats uniformity

`prependArgs` puts our injection **first**, ahead of everything the caller wrote. That single fact
turns findings 2 and 3 into a safety argument:

- **Under `-c`,** any caller argv the guard fails to recognise wins **silently** — by last-wins
  (`-c` vs `-c`, finding 3) or by flag precedence (`-s` vs `-c`, finding 2). A guard miss produces
  a guest running _above_ the requested rung, with no error, no exit code, and nothing in the
  transcript.
- **Under `-s`/`-a`,** the same guard miss either **hard-fails at exit 2** (a repeated `-s`) or
  **our injected flag beats the caller's `-c`** (finding 2, in our favour).

**`-c` fails open and quiet; `-s`/`-a` fails closed or loud.** For a knob whose entire purpose is
that a guest never runs above the requested rung, **that asymmetry outweighs structural uniformity
with `src/wrapper/internal/effort.ts` and `src/wrapper/internal/model.ts`**, which both emit the
`-c key="value"` shape. Those two knobs are performance/selection settings whose worst failure is
a wrong model or a wrong effort level; this one is a containment boundary. Do not "harmonise" the
permission encoding onto the `-c` shape for consistency — the inconsistency is the point, and it is
load-bearing.

## 4. `-p` / `--profile`: unknowable is not the same as unrestricted

`-p, --profile <CONFIG_PROFILE_V2>` exists on codex-cli 0.144.5 ("Layer
`$CODEX_HOME/<name>.config.toml` on top of the base user config"). The question was whether
injecting a rung on top of a caller-supplied profile is ambiguous.

The obvious instruments both fail: **`codex doctor` rejects `-p`** (_"--profile only applies to
runtime commands and `codex mcp`…"_, exit 1), and **`codex sandbox` ignores both `-p` and `-s`**
(it honours only `-c`, so every combination blocks a write identically — a false negative, not a
result). **`codex debug prompt-input` is the instrument**: it is on `-p`'s allowed-command list and
renders the model-visible permissions block, which states the resolved `sandbox_mode` verbatim.

With `CODEX_HOME` pointed at a throwaway directory containing `wide.config.toml`
(`sandbox_mode = "danger-full-access"`, `approval_policy = "never"`), on codex-cli 0.144.5:

| argv                                  | resolved `sandbox_mode` | resolved approval |
| ------------------------------------- | ----------------------- | ----------------- |
| `-p wide`                             | `danger-full-access`    | `never`           |
| `-s read-only -p wide`                | `read-only`             | `never`           |
| `-p wide -s read-only`                | `read-only`             | `never`           |
| `-c sandbox_mode="read-only" -p wide` | `read-only`             | `never`           |
| `-p wide -c sandbox_mode="read-only"` | `read-only`             | `never`           |
| `-s read-only -a untrusted -p wide`   | `read-only`             | not `never`       |

**Result: a flag or `-c` override beats the profile on the axis it sets, in either order — but the
profile still supplies every axis you leave unset.**

So `-s read-only -p wide` resolves to `read-only` plus the profile's `never`. That posture is
**not a rung**: `(read-only, never)` appears nowhere in the forward map, and naming it `manual`
(the ceiling for `read-only`) would _under-report the approval axis_ — the one direction a safety
field must never fail in. The `-p` rule is therefore unconditional on `-p`'s presence, and does
**not** get scoped to "`-p` present and no `-s`". The one exception is a _ceiling_, not a floor: if
the sandbox axis resolves to `danger-full-access` (by flag or by `-c`), the posture is unrestricted
whatever the profile adds, so the proof-of-unrestricted check reports `bypass` first.

### The line that governs it

> **Reject when argv proves the launch would be unrestricted; suppress-and-report-`""` when argv
> makes the launch posture unknowable.**

`--dangerously-bypass-approvals-and-sandbox` in argv is **proof**: the launch _is_ unrestricted, so
pairing it with a restrictive rung is a contradiction, and validation says so. `-p wide` proves
**nothing** — the posture lives in a TOML file the wrapper does not read, so there is no
proposition to contradict. Suppressing injection and reporting `""` is the honest answer, and
`""`'s documented contract ("UNKNOWN, never `default`"; callers must not read it as a definite
non-bypass answer) is exactly the semantics required. The two treatments are not inconsistent —
they are the two halves of one rule.

_(An earlier revision also argued that rejecting `-p` "would break every caller with a legitimately
restrictive profile". That argument is **dropped**: the guard only engages when a `PermissionMode`
is also set, and that combination is brand new, so there are no such callers to break. The
unknowability argument is the whole of it.)_

**Residual, honestly scoped.** The approval readout in the table above is definitive only for
`never` — the prompt block prints "Approval policy is currently …" only in that case, so the
approval-axis rows are inferred from the line's absence. The sandbox axis, which is the one that
decides filesystem reach, is directly reported. Resolving the profile at launch time (via
`codex debug prompt-input`) would let the guard _decide_ rather than _report_, but that is a
subprocess call on the launch path and is not proposed. If a later codex release exposes approval
in `doctor --json` under a `-p`-accepting command, tighten it.

## 5. The guard is a strict superset of what we emit — deliberately

We **emit** only `-s`/`-a`. We **guard** considerably more:

| harness | guarded (suppresses injection)                                                                                                                                                                          | emitted                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| codex   | `-s`, `--sandbox`, `-a`, `--ask-for-approval`, `-p`, `--profile`, `--dangerously-bypass-approvals-and-sandbox`, **and** the config keys `sandbox_mode` / `approval_policy` (in all four `-c` spellings) | `-s <sandbox> [-a <policy>]` |
| claude  | `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` — and **never `-p`**                                                                                      | `--permission-mode <value>`  |

Two things a future reader must not misread:

- **The `-c` keys stay in the codex guard even though we never emit `-c`.** They are there because
  §2 finding 3 says a caller's `-c` is _silently_ last-wins against another `-c` and _loses_ to our
  `-s` — so the danger is not that our injection is overridden, it is that a caller who wrote
  `-c sandbox_mode="danger-full-access"` gets a rung _reported_ that the launch does not deliver.
  **Dropping the `-c` keys from the guard re-opens exactly the fail-open the probes describe.**
  This is not dead code and not an oversight; do not tidy it away for symmetry with the emit side.
- **`-p` is guarded on codex and must never be guarded on claude.** On claude, `-p` is `--print` —
  the single most common invocation shape there is. Guarding it would suppress permission-mode
  injection for effectively every non-interactive claude launch. The asymmetry is intentional and
  is a property of the two CLIs, not of our design.

## 6. The standing three-site rule

> **Anything that suppresses injection must also (i) be in the injection guard, (ii) be readable by
> `EffectiveLaunchRung` — resolving to a rung when argv _proves_ one, and to `""` when it does not
> — and (iii) have corpus rows.**

Skipping (ii) is what converts a guard into a fail-open: injection stops, the knob arm still
answers from the requested `mode`, and the wire reports a rung the launch never had. Since
HARNESS-WRAPPER-101 that value goes out on `StructuredTurnResult.permission_mode`, so this is a
**wire-contract** defect an orchestrator can read, not an internal inconsistency. Every guard entry
in §5 is a three-site change; adding a new one without site (ii) is worse than not adding it,
because it converts a _loud_ wrong launch into a _quiet_ wrong report.

## 7. Rung ordering and vocabulary: the canonical rung is `ask`

**The canonical rung identifier is `ask`, not `acceptEdits`.** `PermissionRungs()` returns
`{plan, manual, ask, auto, bypass}`, in that order.

**`ask` sits _above_ `manual`**, because `ask` auto-accepts edits while `manual` prompts for them.
The name reads backwards — that is the readability concern MH-99 raised when it proposed renaming
the rung to `acceptEdits` — but the rename is the expensive answer, because `ask` is already frozen
on a merged wire contract:

- `pkg/wrapper/permission_rungs_test.go:9` and `:22` assert that exact ordered slice;
- `crossrepo/meta-harness/HARNESS-WRAPPER-101-structured-result-permission-mode.md` freezes
  `StructuredTurnResult.permission_mode`'s value space as _canonical rungs only_ —
  `plan | manual | ask | auto | bypass` — with "a native spelling is **never** emitted;
  `acceptEdits` is reported as `ask`";
- `pkg/turnproto/protocol.go:105-107` repeats it;
- `clients/python/harness_chat.py:43-56` carries the same `Literal`.

A rename would churn a merged wire contract, a conformance fixture, a Python client literal and a
crossrepo note, to change a name **no user ever sees** — callers write `acceptEdits` on the claude
axis either way, because that is what argv gets.

**`acceptEdits` therefore remains two things:** (i) claude's native `--permission-mode` value, which
_both_ implementations emit for the `ask` rung, and (ii) an accepted _input_ spelling that
normalises to `ask`. **No Go rename, no alias machinery, no `canonicalRung()` shim, no wire churn.**
MH-99's readability concern is answered by this paragraph — documenting the ordering next to the
rung list — rather than by a rename.

## 8. The version floor

Every fact this note freezes — `--allow-dangerously-skip-permissions`, `-p`/`--profile`, the
`doctor --json` readouts, the Shift+Tab ring membership — is a fact about **codex-cli 0.144.5 /
claude-code 2.1.217**. Three statements settle what that means for this repo:

1. **The pin moves, and META-HARNESS-132 does not move it.** `src/versions/versions.json` here pins
   codex **0.142.5** / claude-code **2.1.201**, and `test/conformance.test.ts`'s version-drift half
   fails on divergence from that pin. **META-HARNESS-102 owns the bump** to 0.144.5 / 2.1.217,
   because the bump must land together with the corpus captures and the `discover()` expectations
   that ride on those pins. 132 states the floor and points at 102; it does not duplicate the bump.
2. **harness-wrapper is already at 0.144.5 / 2.1.217, and its cross-repo checker is expected red
   until 102 lands.** HARNESS-WRAPPER-109 bumped `pkg/versions/versions.json` _and_ hand-edited the
   vendored snapshot `pkg/versions/testdata/meta-harness-versions.json` to match, so the hermetic
   parity test passes while `scripts/sync-versions.sh --check` — a dev-machine tool, never run by
   `make test` — reports drift against this repo. HW-109's README calls this "expected red on a dev
   machine until the paired meta-harness bump lands." **Recorded here so nobody "fixes" it by
   reverting the Go pins.**
3. **Below the floor, the extra guard entries are inert, not wrong.** The guard is
   **presence-based**: it suppresses injection only for a flag or key the _caller_ actually wrote.
   A caller cannot usefully write a flag the installed binary rejects — the harness itself rejects
   the argv. So guarding `--allow-dangerously-skip-permissions` or `-p` against an older binary
   costs nothing, while _not_ guarding a flag the installed binary does accept is a fail-open. The
   guard is written for the newest observed version by design, and this asymmetry is the reason.

**The live `codex doctor --json` gate lives on the Go side.** A `CONFORMANCE=1`-gated verification
added _here_ would sit in the same file as `test/conformance.test.ts`'s version-drift assertion,
which is pinned to 0.142.5 / 2.1.201, and would fail for an unrelated reason. harness-wrapper's
pins already match the probed versions, so the gate goes there.

## 9. The parity bar for permission-mode argv

**Exact token-sequence equality between the Go and TypeScript implementations, for every
`{harness, rung, caller_args}` row.**

This is deliberately stricter than the bar `crossrepo/meta-harness/HARNESS-WRAPPER-78-sandbox-defaults-argv.md`
records for `--sandbox-defaults`, where argv parity is _"up to position, not byte-equality"_ (Go
appends the claude token after the caller's args; meta-harness prepends it, and claude parses those
flags position-independently). **Those HW-78 divergences stay open and are out of scope here** —
this note neither closes them nor loosens itself to match them.

Permission-mode argv gets the stricter bar for two reasons:

- **Both sides inject at the same seam.** Go prepends via `prependArgs` in
  `argsWithHarnessPermissionMode` (`pkg/wrapper/wrapper.go:598`); TS prepends in
  `src/wrapper/internal/run.ts`, beside the existing effort and model calls. Position is therefore
  not a free variable the way it is for the sandbox-defaults token — the two implementations are
  structurally committed to the same placement, so equality is free.
- **Position can change the resolved value.** A permission directive parsed last-wins (§2 finding 3)
  resolves differently depending on where it sits relative to the caller's own tokens. For a
  containment knob, a "cosmetic" position difference is not cosmetic.

**Error _text_ parity is explicitly not claimed.** The two implementations return their own
`ErrInvalidConfig` message wording; only the accept/reject _outcome_, the emitted argv, and the
`effective_rung` are held to parity.

---

## Amendments this decision requires

META-HARNESS-100 is `blocked` and unimplemented; the following are **description amendments, not
rework**, and **MH-100 must not be implemented before they land**.

_In META-HARNESS-100:_ (1) mapping-table codex column → `-s <sandbox> [-a <policy>]` for all five
rungs; (2) the "Why `-c` and not `-s`/`-a` on codex (A2)" section → a pointer to §2 above, keeping
the `-c` keys documented as the caller-passable equivalent spelling that suppresses injection;
(3) mapping-table rung column `acceptEdits` → `ask`, with the "Two renames from the earlier draft"
bullet inverted (§7) — the claude column stays `--permission-mode acceptEdits`; (4) item 4's three
frozen `ErrInvalidConfig` strings, two of which currently enumerate the vocabulary as "one of plan,
manual, acceptEdits, auto, bypass" and would ship TS error text naming a claude-only native
spelling as if it were canonical; (5) the "Native spellings" codex bullet inverted, plus the
single-axis arm added to item 1's `argsWithHarnessPermissionMode` spec; (6) item 2's codex guard
list gains `-p`, `--profile`.

_In META-HARNESS-99:_ (7) mapping-table rung column `acceptEdits` → `ask`, with the "Changes from
the first draft" bullet inverted for the reason in §7. MH-99's plan-critic "row J" recommended the
same rename but lives in a **comment** — a historical record, not rewritten; the supersession is
noted in the description instead.

**No amendment touches the codex `plan` or codex `manual` rows in either ticket** — this decision
adopts both as the epic wrote them.
