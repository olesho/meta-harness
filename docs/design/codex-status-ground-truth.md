# codex `/status` ground truth — the frozen `Permissions:` mapping table (META-HARNESS-110)

**Status:** settled · 2026-07-23 · probed live in META-HARNESS-110, recorded here so it is not
re-derived. **This is the text to write back into META-HARNESS-99's ground-truth table.**
**Scope:** what codex's `/status` box actually renders for each `-s`/`-a` launch, which rung each
rendering maps to, and the recorded fixtures that hold the mapping in place. The read side only —
argv encoding is settled separately in `permission-argv-parity.md`.
**Related:** META-HARNESS-99 (epic, owns the ground-truth table) · META-HARNESS-132
(`permission-argv-parity.md`, the write side) · META-HARNESS-155
(`codex-status-preflight-probe.md`, the pre-flight probe that re-confirmed the `Permissions:` row
and enumerated the **full** row set) · `src/chat/permission.ts` (`codexPermissionRungs`) ·
`src/turns/harness/codex.ts` (`statusSessionRE`, `statusBoxHeaderRE`, `CODEX_STATUS_MIN_COLS`) ·
`test/corpus/codex/status-*` (the recordings).

---

## 1. Environment

**codex-cli 0.144.5, macOS, 120x40, recorded 2026-07-23.** Every row below was launched
end-to-end, driven to a `/status` box, and captured with
`test/corpus/tools/record-pty.ts --interactive`. Nothing here is predicted; each row names the
fixture that carries it.

The version is recorded in each fixture's `meta.json` so the subtask that owns
`src/versions/versions.json` can cite it. This note bumps no pin.

## 2. The frozen table

| launch flags                       | `Permissions:` rendering        | rung          | fixture                     |
| ---------------------------------- | ------------------------------- | ------------- | --------------------------- |
| _(none — codex's own default)_     | `Workspace (Ask for approval)`  | `acceptEdits` | `status-box`²               |
| `-s workspace-write -a on-request` | `Workspace (Ask for approval)`  | `acceptEdits` | `status-default`            |
| `-s workspace-write -a untrusted`  | `Custom (workspace, untrusted)` | `manual`      | `status-manual`             |
| `-s workspace-write -a never`      | `Custom (workspace, never)`     | `auto`        | `status-auto`               |
| `-s danger-full-access -a never`   | `Full Access`                   | `bypass`      | `status-bypass`             |
| `-s read-only -a untrusted`        | `Read Only (untrusted)`         | `plan`¹       | `status-readonly-default`   |
| `-s read-only -a never`            | `Read Only (never)`             | `plan`¹       | `status-readonly-never`     |
| `-s read-only -a on-request`       | `Read Only (Ask for approval)`  | `plan`¹       | `status-readonly-onrequest` |
| — (unreachable from the CLI)       | `Workspace (Approve for me)`    | **no rung**   | —                           |
| anything else                      | —                               | **no rung**   | —                           |

¹ Permissions axis **only**. See §5.

² Added by META-HARNESS-155 (`codex-status-preflight-probe.md`). A **flagless** launch renders the
same string as `-s workspace-write -a on-request` because that pair **is** codex's default posture.
The consequence matters for anyone writing a live check: those two launches are indistinguishable
from the `Permissions:` row alone, so a `/status` assertion driven only at the default posture
exercises none of the forward `(sandbox, approval) → rung` map. Use a non-default posture.

"No rung" means `observed: "unknown"` with the value preserved verbatim in `raw` — an off-ladder
state, not a failure to see.

`Collaboration mode:` renders `Default` on every launch above. `Plan` appears only after a
post-launch `/plan` (`status-plan`).

**The full row set** — `Model:`, `Directory:`, `Permissions:`, `Agents.md:`, `Account:`,
`Collaboration mode:`, `Session:`, and a trailing limits row (`Weekly limit:` when limits data is
loaded, `Limits:` when it is not) — is enumerated with per-row stability notes in
`codex-status-preflight-probe.md` §2/§6. Only `Permissions:` and `Collaboration mode:` are parsed
here; `Directory:` and the limits row are **not** stable enough to anchor on.

## 3. Two corrections to the predicted table

**`auto` is confirmed — the acceptance gate.** `-s workspace-write -a never` really does render
`Custom (workspace, never)`. The provisional row stands unchanged. A codex session launched at rung
`auto` now round-trips `requested === observed` instead of reporting permanent, unresolvable drift
on a rung the ladder can express.

**`plan` is corrected — `Custom (read-only, untrusted)` does not exist.** 0.144.5 gives the
read-only sandbox its **own presentation family**, `Read Only (<policy>)`, rather than the
`Custom (<sandbox>, <policy>)` form the table predicted. That predicted key is gone.

The family is **not uniform** in how it spells the approval policy: `untrusted` and `never` appear
verbatim, `on-request` is prettified to `Ask for approval` (matching the workspace family's
`Workspace (Ask for approval)`). That irregularity is the reason `codexPermissionRungs` is an
exhaustive lookup of **observed strings** and never a parsed `<sandbox>, <policy>` pair: an
unobserved spelling must fall through to `unknown` + `raw`, not be reconstructed by guessing.

One asymmetry worth recording: under `danger-full-access` the approval policy vanishes from the
rendering entirely (`Full Access`, no parenthetical), so `-a never` is invisible there while it is
load-bearing under `workspace-write`.

## 4. Why the whole `Read Only (…)` family maps to `plan`

The approval policy discriminates three rungs under `workspace-write` (`on-request` → acceptEdits,
`untrusted` → manual, `never` → auto). It **cannot** discriminate under `read-only`: nothing is
writable, so there is no edit for an approval policy to gate, and every read-only session is the
same permissions posture.

Mapping only the `untrusted` spelling would leave a session launched `-s read-only -a never`
reporting permanent unresolvable drift — `normalizePermissionRung` maps the `read-only` launch
spelling to `plan`, so `requested` would be `plan` against a forever-`unknown` `observed`. That is
the same failure mode the `auto` gate exists to prevent.

## 5. `plan` is two axes, and they do not collapse

The epic's `plan` rung for codex is `-s read-only -a untrusted` **plus** a post-launch `/plan`. A
session is honestly "plan" only when `observed === "plan"` **and** `collaboration === "plan"`.

`status-readonly-default` and `status-plan` were launched with **identical** flags and differ only
in whether `/plan` ran. They read:

| fixture                   | `observed` | `collaboration` |
| ------------------------- | ---------- | --------------- |
| `status-readonly-default` | `plan`     | `default`       |
| `status-plan`             | `plan`     | `plan`          |

`collaboration` is read only from a **positive** `Collaboration mode:` row. Absence is not a
signal — a missing row is `unknown`, never `default`.

**Recording note:** `/plan` is rejected with `'/plan' is disabled while a task is in progress`
while codex is still booting its MCP servers. The capture waits ~40s before sending it.

## 6. `Workspace (Approve for me)` stays unmapped

It was **not** re-probed here, because it is unreachable from the CLI: `-a granular` is rejected and
the accepted `-a` values are `untrusted | on-request | never`. It therefore can never be a
`requested` rung, so coercing it onto one could only manufacture false drift alarms. It reports
`observed: "unknown"` with the value in `raw`, like any other off-ladder state. This is the same
reasoning as before the probe; nothing about it changed.

The off-ladder `dontAsk` value was not observed in any `/status` or footer rendering during this
probe. Probing it remains out of scope.

## 7. Measured widths — and the `CODEX_STATUS_MIN_COLS` follow-up

Measured from the recordings at 120x40. "Intrinsic" is the minimum **unwrapped** width a row needs:
opening `│` + label column + value + closing `│`. The label column is fixed by the widest label
(`Collaboration mode:`), which is why the values themselves are not the binding constraint.

| row                   | intrinsic cols                                     |
| --------------------- | -------------------------------------------------- |
| `Directory:`          | 94 (cwd-dependent, not parsed)                     |
| `Session:`            | **62**                                             |
| `Permissions:`        | up to 55 (widest: `Custom (workspace, untrusted)`) |
| `Collaboration mode:` | 30–33                                              |

Rendered box width: **95 cols**.

**`CODEX_STATUS_MIN_COLS = 60` is 2 short.** Its docstring derives 60 from the 36-char UUID plus
`Session: ` plus borders, but the real box indents every value into that fixed label column, so the
`Session:` row needs 62. **Raising it is a follow-up, not a defect here, and this note is the fresh
evidence for it.** It is a heuristic gate on _whether the primer writes `/status` at all_; both
reads that consume the box (`statusSessionRE` and the two permission row regexes) require the
closing `│` on the **same physical line**, so a wrapped row fails **closed** at any width. The
constant being low costs a capture, never a wrong answer.

## 8. What holds this in place

`test/chat/permission.test.ts` replays all eight fixtures through `corpusBytes` + `newScreen` and
asserts each `Permissions:` value against its frozen rung, both collaboration readings against the
**painted** row, and the two-axis independence in §5.

`test/turns/codex/sessionid.test.ts` replays the same fixtures through `extractSessionID`. Before
they existed there was no `/status` box anywhere in `test/corpus/`, so `statusSessionRE` — the
load-bearing session-id scrape — had **zero** recorded coverage and a real layout change would not
have failed a single test.

**Redaction:** the live `Account:` row carried the recording operator's login. It is replaced
byte-for-byte in `bytes.raw` (16 chars in, 16 chars out) so every column of the box renders exactly
as captured. Each `meta.json` records this as the only edit to the recording.
