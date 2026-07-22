# Wire-contract text for `StructuredTurnResult.permission_mode` — two new caveats

**Workspace:** `harness-wrapper` · **Type:** task · **Priority:** 1
**Repo:** `harness-wrapper`. Line numbers verified against `117c0b1`.

> **Rides in Ticket 2's commit** (which is also Ticket 1's commit). The behaviour changes and the
> text describing it must not be separately bisectable — a reader landing between them would get a
> doc block that is confidently wrong about the field they are consuming.

## Why this is a ticket at all

`pkg/turnproto/protocol.go`'s `PermissionMode` doc block (`:105-157`, field declaration at `:157`)
is not commentary — it is the **consumed specification** of a safety field. META-HARNESS-101's
consume side models this field off that block. Tickets 1 and 2 change two of its guarantees, so
the block changes in the same commit.

The block's existing structure is a bullet list of caveats, including the two that these edits
attach to: _"Presence of `bypass` is trustworthy for turns that reached the harness"_ and
_"ABSENT NEVER MEANS SAFE"_.

## Caveat (i) — the reported rung may differ from the requested rung

Add, as its own bullet:

> **MAY DIFFER FROM THE REQUESTED RUNG.** codex has no launch-time `plan`; a codex turn requested
> as `plan` launches `-s read-only -a untrusted` and is reported as `manual`.

This is a **new class of divergence** for this field. The block already documents a divergence
between _this_ field and `cmd/harness-chatd`'s `conversationSummary.permission_mode` (the
`DIVERGENCE` paragraph at `:145-152`: requested-verbatim vs effective-canonical). Caveat (i) is
different and must not be folded into it: here the _same_ field, on the _same_ turn, reports a rung
the caller did not ask for. A consumer that round-trips request → result and asserts equality is
correct today and wrong after Ticket 2.

## Caveat (ii) — scope the bypass-trustworthiness bullet to postures argv _proves_

The existing bullet reads:

> _"Presence of `bypass` is trustworthy for turns that reached the harness: every unrestricted
> launch path reports it, including the ones carrying no canonical `--permission-mode` at all
> (`--sandbox-defaults`' injected `--dangerously-skip-permissions`, a raw
> `--dangerously-skip-permissions` after `--`, codex's `-s danger-full-access` in every
> spelling)."_

Scope it: the guarantee is over postures argv **proves**. A caller-supplied `-p` / `--profile`
yields `""`, **not** `bypass`, even when the referenced profile is entirely unrestricted — because
the posture lives in a TOML file the wrapper does not read.

State explicitly that this is a **fresh instance of the existing "ABSENT NEVER MEANS SAFE" rule
and NOT an exception to the bypass guarantee.** The distinction matters to a consumer writing an
`if rung == "bypass" { … }` branch: absence of `bypass` never licensed a safety conclusion in the
first place, so nothing that was previously sound becomes unsound. If it is written as an
exception, a reader will reasonably infer the guarantee has holes elsewhere too.

The `-c sandbox_mode="danger-full-access"` spelling **stays inside the guarantee** — Ticket 2's
seven-step ordered rule, step 2, resolves it to `bypass` before any unknown-yielding step can
fire. Say so, so a reader does not assume all `-c` spellings degrade to `""`.

## Mirror both caveats into the crossrepo note

`crossrepo/meta-harness/HARNESS-WRAPPER-101-structured-result-permission-mode.md` is the staged
handoff for META-HARNESS-101, whose consume side models this field. Both caveats go into its
"Wire contract" / "SEMANTICS DIVERGENCE" sections (`:34` and `:42` onward). Wording should match
the Go doc block; if it must diverge, the Go block is the source of truth and the note says so.

## Also note the known-wrong adjacent seam — do not let it be silently assumed

Ticket 2 (2c) justifies reporting `manual` for a codex `plan` request by **deferring the honesty
about the collaboration axis to the detector on that axis** —
`(*Adapter).PermissionMode` in `pkg/turns/harness/codex/codex.go:167-189`.

**That detector currently mis-reports the exact case being deferred to it.** HARNESS-WRAPPER-109
recorded `test/corpus/permission-mode/codex/plan-narrow-gutter/meta.json`, whose `pending_parser`
field (`:8`) states: at 120 cols with a long cwd, codex truncates the left half of the hint row
with `…` and leaves a **single space** before `Plan mode`. `collaborationPlanRE`
(`pkg/turns/harness/codex/permmode.go:59`, used at `:94`) requires the marker to be preceded by
start-of-row or two-or-more horizontal spaces, so it does not match and the adapter reports
**`"default"`** — _a wrong axis value, not an unreadable screen_. The 200-col capture of the same
session parses correctly, which pins the gutter rule as the cause (see also
`test/corpus/permission-mode/README.md:182`).

So the sentence "the collaboration axis tells you the truth about `plan`" is **not yet true at the
width real sessions run at**. Say this plainly in the ticket and in 2c's doc comment.

**Widening the gutter rule belongs to the parser ticket** (META-HARNESS-102 / the
HARNESS-WRAPPER-106 follow-up). **Name it as a dependency; do not fold it in.** Folding a regex
widening into a permission-argv commit mixes a screen-parsing change with a launch-argv change and
makes both harder to bisect. The `pending_parser` field is dropped by _that_ ticket, not this one.

## Acceptance

- [ ] `pkg/turnproto/protocol.go:105-157` carries both caveats, as bullets in the existing list,
      in the same commit as Tickets 1 and 2.
- [ ] Caveat (ii) is worded as an instance of "ABSENT NEVER MEANS SAFE", not as an exception to
      the bypass guarantee, and explicitly keeps `-c sandbox_mode="danger-full-access"` inside the
      guarantee.
- [ ] Both caveats mirrored into
      `crossrepo/meta-harness/HARNESS-WRAPPER-101-structured-result-permission-mode.md`.
- [ ] The `collaborationPlanRE` gutter defect is named as a dependency (with the corpus path and
      the `pending_parser` quote) in this ticket and in 2c's doc comment, and is **not** fixed
      here.
