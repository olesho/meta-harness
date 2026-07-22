# Crossrepo handoff note: `HARNESS-WRAPPER-<n>-permission-argv.md` (+ a one-line correction to HW-77 and HW-101)

**Workspace:** `harness-wrapper` · **Type:** task · **Priority:** 2
**Repo:** `harness-wrapper`. Line numbers verified against `117c0b1`.

Write a **fourth** note into `crossrepo/meta-harness/`, alongside the three that already live
there:

- `HARNESS-WRAPPER-77-permission-mode.md` — the **launch knob**
- `HARNESS-WRAPPER-78-sandbox-defaults-argv.md` — the **argv tripwire**
- `HARNESS-WRAPPER-101-structured-result-permission-mode.md` — the **result side**

New file: `crossrepo/meta-harness/HARNESS-WRAPPER-<n>-permission-argv.md`, where `<n>` is this
ticket's own number.

**Cross-link it from all three existing notes** rather than starting a parallel track. These four
notes describe one seam from four angles; a reader who finds any one of them must be able to reach
the other three. Add the back-link near the top of each, where HW-101 already carries its
`> **META-HARNESS-129** … the number of record is **META-HARNESS-101**` callout (`:13`).

## What the note carries

### 1. The parity bar, distinguished from HW-78

HW-78 sets a **weaker** bar and says so: its `--sandbox-defaults` argv parity is _"up to position,
not byte-equality"_ (`HARNESS-WRAPPER-78-sandbox-defaults-argv.md:64`), and its host-set
`IS_SANDBOX` divergence (`:57-64`) **stays open and is out of scope here**.

Permission-mode argv is **exact token-sequence equality**. Both languages inject through
`prependArgs` (`pkg/wrapper/wrapper.go:887`) at the same seam, emitting a fixed prefix ahead of the
caller's untouched args — there is no reordering, no merging, and no environment half. State the
two bars side by side so nobody imports HW-78's looser bar into this one, or vice versa reads
HW-78's open `IS_SANDBOX` gap as a regression here.

### 2. The `workspace-write → auto` replay change

Ticket 2 (2d) makes a bare `-s workspace-write` — and the `workspace-write` single-axis knob —
resolve to **`auto`** instead of `ask` (the single-axis ceiling). This is **user-visible on the
wire** via `StructuredTurnResult.permission_mode`. Two frozen rows flip
(`pkg/wrapper/permission_rungs_test.go:130` and `:137`). Any meta-harness consumer that pins the
old value must be told before it lands, not after.

### 3. The HW-106 / HW-109 `collaborationPlanRE` dependency

Carried over from Ticket 3. Ticket 2c defers the honesty about codex's collaboration axis to
`(*Adapter).PermissionMode` (`pkg/turns/harness/codex/codex.go:167-189`), and that detector today
mis-reports the exact deferred case: `collaborationPlanRE`
(`pkg/turns/harness/codex/permmode.go:59`, used at `:94`) requires start-of-row or ≥2 spaces before
the `Plan mode` marker, and at 120 cols with a long cwd codex leaves a single space, so the adapter
reports `"default"` — a wrong axis value, not an unreadable screen. Recorded as `pending_parser` in
`test/corpus/permission-mode/codex/plan-narrow-gutter/meta.json:8`; see also
`test/corpus/permission-mode/README.md:182`. Widening the rule belongs to
META-HARNESS-102 / the HARNESS-WRAPPER-106 follow-up. **Named as a dependency, not folded in.**

### 4. The version-floor statement

harness-wrapper is pinned at **codex-cli 0.144.5 / claude 2.1.217**. meta-harness stays at
**0.142.5 / 2.1.201** until **META-HARNESS-102** bumps it.

Therefore **`scripts/sync-versions.sh --check` is EXPECTED RED on a dev machine until then.**
Write this in the note in exactly those terms, because the failure mode is somebody "fixing" it by
reverting the Go pins — which would silently un-verify Ticket 4's live gate and Ticket 1(c)'s
`claude --help` evidence. This mirrors the treatment HW-77 (`:73`) and HW-101 (`:107`) already give
`scripts/check-conformance-corpus.sh`: _"That failure is the expected state"_, not a bug.

### 5. The codex-`plan` → `manual` caveat

A codex turn requested as `plan` launches `-s read-only -a untrusted` and is **reported as
`manual`** (Ticket 2c, Ticket 3 caveat (i)). Same wording as the Go doc block in
`pkg/turnproto/protocol.go:105-157`, which is the source of truth.

---

## Plus: a one-line correction to HW-77 and HW-101

Both notes attribute the conformance **vendoring/pull script** to META-HARNESS-101:

- `HARNESS-WRAPPER-77-permission-mode.md:68-70` — _"`scripts/check-conformance-corpus.sh:5-14` in
  this repo is deliberately check-only and never writes into the sibling; the pull/vendoring script
  is META-HARNESS-101's deliverable."_
- `HARNESS-WRAPPER-101-structured-result-permission-mode.md:103-104` — same sentence.

**That attribution is wrong.** META-HARNESS-101 is **request-side only** and its description does
not contain the vendoring script. Point both notes at **META-HARNESS-132** instead.

The specific sentence to re-attribute is **HW-101's Acceptance item 3** (`:117`):

> _"Re-vendor `test/conformance/` in meta-harness, then `scripts/check-conformance-corpus.sh` goes
> green."_

Correct the same claim in HW-77's Acceptance (`:79-80`). This is a one-line edit in each file — do
not restructure either note.

## Acceptance

- [ ] `crossrepo/meta-harness/HARNESS-WRAPPER-<n>-permission-argv.md` exists and carries all five
      items above.
- [ ] HW-77, HW-78 and HW-101 each cross-link to it.
- [ ] HW-77 (`:68-70`, `:79-80`) and HW-101 (`:103-104`, `:117`) re-attribute the vendoring script
      from META-HARNESS-101 to META-HARNESS-132.
- [ ] The note states the parity bar as **exact token-sequence equality** and explicitly contrasts
      it with HW-78's _"up to position"_ bar, leaving HW-78's `IS_SANDBOX` divergence out of scope.
- [ ] The note states that `scripts/sync-versions.sh --check` is expected red until
      META-HARNESS-102 bumps the meta-harness pins, and that reverting the Go pins is **not** the
      fix.
