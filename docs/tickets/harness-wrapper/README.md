# harness-wrapper follow-up tickets — permission-mode argv (META-HARNESS-145)

Five ship-ready ticket bodies produced by **META-HARNESS-145**, which is step 6 of the
META-HARNESS-132 plan. They are follow-ups (not amendments) to
**HARNESS-WRAPPER-74 / 77 / 78 / 101 / 106 / 109**, all of which are merged.

They target the **`harness-wrapper` workspace**, not this repo. They are staged here as files
because META-HARNESS-145 runs headless and is not permitted to invoke `orche`. File them with:

```sh
for f in docs/tickets/harness-wrapper/0*.md; do
  orche ship --workspace harness-wrapper --file "$f"
done
```

The first `# ` heading of each file is the ticket title; everything below it is the description.
Ship them in numeric order so the dependency notes (Ticket 4 blocks on 1–3) reference tickets that
already exist.

| File | Ticket | Lands with |
|---|---|---|
| `01-guard-set-reconciliation.md` | Guard sets: codex `-p`/`--profile`, codex `-c sandbox_mode=`/`approval_policy=`, claude `--allow-dangerously-skip-permissions` | one commit with 02 + 03 |
| `02-mapping-reconciliation.md` | codex `manual` → `-s workspace-write -a untrusted`; codex accepts `plan`; two-axis replay + single-axis ceiling | one commit with 01 + 03 |
| `03-wire-contract-text.md` | `turnproto.PermissionMode` doc caveats + crossrepo mirror | rides in 02's commit |
| `04-exported-api-and-argv-corpus.md` | Export `PermissionArgs` / `ValidatePermissionMode`, `test/conformance/permissions/argv.json`, `CONFORMANCE=1` live gate | **blocked on 01–03** |
| `05-crossrepo-note.md` | Fourth `crossrepo/meta-harness/` note + HW-77/HW-101 attribution fix | independent |

## The rule every ticket restates up front

**A guard entry is a three-site change.** Anything that suppresses injection must (i) enter the
injection guard, (ii) enter `EffectiveLaunchRung`'s arm — a rung when argv *proves* one, `""` when
it does not — and (iii) get corpus rows. Skipping (ii) converts a guard into a fail-open on
`StructuredTurnResult.permission_mode`.

## Provenance of the citations

Every symbol and line hint in these tickets was checked against the read-only reference checkout
`~/Work/aether/harness-wrapper` at **`117c0b1`** before being written. Where META-HARNESS-132's
own line hints had drifted by a line or two, the **verified** number is used here:

- `permission_mode_test.go` — the claude `-p` freeze is the `"claude-code auto"` row at
  **`:82-88`** (MH-132 said `:85-101`); the `"codex manual"` row is **`:100-106`**.
- `permission_rungs_test.go` — the attached-short `workspace-write` row is **`:130`**
  (MH-132 said `:129`; `:129` is the `--sandbox=read-only` row).
- `wrapper.go` — the `-c` emit sites are **`:443`** and **`:473`** (MH-132 said `:443`/`:475`).
- `pkg/turns/harness/codex/codex.go` — the quoted asymmetry (1) is **`:176-182`** inside the
  `(*Adapter).PermissionMode` doc block **`:167-189`** (MH-132 said `:172-189`).

Everything else matched exactly: `wrapper.go:359`, `:367-372`, `:598`, `:612`, `:624`, `:674`,
`:694`, `:739`, `:775`, `:786-797`, `:824`, `:833`, `:863`, `:915`, `:936`, `:954`;
`permission_rungs_test.go:58-79`, `:81-90`, `:137`, `:167-199`, `:202-228`, `:262-273`;
`permission_mode_test.go:98-99`, `:477`, `:605`; `turnproto/protocol.go:105-157`, `:145-152`;
`conformance_test.go:283-284`, `:295`; `Makefile:155-163`;
`test/corpus/permission-mode/codex/plan-narrow-gutter/meta.json:8`; and meta-harness
`src/turns/harness/codex.ts:271`.

**One reconstruction to reconcile before shipping Ticket 2.** META-HARNESS-132 step 2d's
*seven-step ordered resolution rule* and *single-axis ceiling table* were to be copied verbatim.
META-HARNESS-145 runs without `orche` access, so both were **reconstructed** in
`02-mapping-reconciliation.md` from the evidence carried in this subtask's own description — the
`codex debug prompt-input` probe table, the enumerated moving and non-moving frozen rows, and the
`isSupportedPermissionMode` argument for putting the ceiling inside `codexSandboxRung`. The
reconstruction satisfies every one of those constraints, but it should be diffed against
`orche resolve fleet-db://META-HARNESS-132` step 2d before the ticket is shipped, and any wording
difference resolved in favour of MH-132.
