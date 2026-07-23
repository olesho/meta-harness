# `meta-harness-chatd` (the HTTP + SSE gateway)

The transport layer: a daemon that exposes [`Conversation`](chat.md) over HTTP +
Server-Sent Events so non-Node clients can drive multi-turn harness conversations
across a process boundary. One HTTP conversation maps 1:1 to one in-process
`Conversation`, which maps 1:1 to one supervised harness process.

Source: [`src/gateway/`](../../../src/gateway/) — `server.ts` (routes + registry),
`dto.ts` (wire shapes), `errors.ts` (sentinel → HTTP), `fanout.ts` + `sse.ts` (the
event stream). It runs on **Node** from the compiled
[`dist/gateway/server.js`](../../../dist/gateway/server.js) (declared as the package
`bin` `meta-harness-chatd`).

> **Node only.** The daemon spawns harnesses through `node-pty`, whose `onData` /
> `onExit` are dead under Bun. There is no "works under Bun" path.

> **Not a subpath export.** Unlike every other module here, `src/gateway/` is _not_
> published as `meta-harness/gateway` — the daemon binary is the public surface. The
> classes (`Server`, `Fanout`, `streamSSE`) are importable only from a source checkout,
> and are not frozen by [`test/contract.test.ts`](../../../test/contract.test.ts).

> **Storage.** `chat.Open` requires a `Store`, and `store` is a live object with no wire
> representation — so the daemon supplies one: `defaultOpener` gives each conversation
> its own `newMemStore()`, released when the conversation closes. An embedder passing a
> custom `Opener` can inject any `Store` instead. (Until this was fixed, `defaultOpener`
> supplied none and every `POST /v1/conversations` failed `400 invalid_options`, making
> the entire `/v1/conversations/**` surface unreachable on the shipped binary; the route
> tests all injected their own `Opener`, so nothing caught it.)

---

## Run it

```bash
npx meta-harness-chatd --bind 127.0.0.1:8080
# or, from a checkout:  node dist/gateway/server.js --bind 127.0.0.1:8080
```

`--bind host:port` (also `--bind=host:port`) defaults to **`127.0.0.1:8080`**. On listen
it writes `harness-chatd: listening on <bind>` to **stderr**. `SIGINT` / `SIGTERM`
trigger a graceful shutdown: stop accepting, release every control token, close every
conversation, exit `0`.

### Trust boundary

**v1 has no authentication.** The daemon **spawns harness processes on request** — an
open call is arbitrary local process execution with a caller-supplied `binary_path`,
`args`, `env`, and `working_dir`. Binding it to a routable interface hands that to the
network.

- Bind **localhost only**. Do not bind `0.0.0.0`.
- There is no authn, no authz, and no per-caller isolation: any client that can reach
  the port can open, drive, and close any conversation.
- For sandboxed execution, drive the [environments layer](../../env/README.md) instead
  of exposing this daemon.

---

## The control-token model

The chat layer allows **one mutating operation at a time**, guarded by an exclusive
control token. In-process that token is a release _closure_; over HTTP the daemon mints
an opaque 16-byte hex **string** and keeps `token → release` in its own registry.

The lifecycle is therefore:

```
POST   /v1/conversations                   → 201 { id }
POST   /v1/conversations/{id}/control      → 200 { token }
POST   /v1/conversations/{id}/messages     → 202 { turn_id }     (token required)
GET    /v1/conversations/{id}/events       → SSE stream          (no token)
DELETE /v1/conversations/{id}/control/{token} → 204
DELETE /v1/conversations/{id}              → 204
```

`send` and `answer` are gated on the daemon's own `hasToken` check **before** reaching
chat — a caller holding no token gets `409 no_control` even if nobody else holds
control. Reads (`events`, `history`, `screen`) need no token.

---

## Endpoints

| Method   | Path                                     | Success     | Purpose                                   |
| -------- | ---------------------------------------- | ----------- | ----------------------------------------- |
| `GET`    | `/healthz`                               | `200`       | Liveness — `{"ok":true}`.                 |
| `POST`   | `/v1/conversations`                      | `201`       | Open a conversation (spawns a harness).   |
| `GET`    | `/v1/conversations`                      | `200`       | List live conversations.                  |
| `DELETE` | `/v1/conversations/{id}`                 | `204`       | Close + release all its tokens.           |
| `POST`   | `/v1/conversations/{id}/control`         | `200`       | Acquire control; mint a token.            |
| `DELETE` | `/v1/conversations/{id}/control/{token}` | `204`       | Release a token.                          |
| `POST`   | `/v1/conversations/{id}/messages`        | `202`       | Send a message (token required).          |
| `POST`   | `/v1/conversations/{id}/input`           | `204`       | Answer an input request (token required). |
| `GET`    | `/v1/conversations/{id}/events`          | `200` (SSE) | Subscribe to the event stream.            |
| `GET`    | `/v1/conversations/{id}/history`         | `200`       | The conversation's turns.                 |
| `GET`    | `/v1/conversations/{id}/screen`          | `200`       | The rendered terminal snapshot.           |
| `GET`    | `/v1/conversations/{id}/permission-mode` | `200`       | The live permission-ladder reading.       |
| `POST`   | `/v1/turns`                              | `200`       | Run one complete turn and tear down.      |

An unmatched path or method is `404 not_found`.

### `POST /v1/conversations`

Body — every field optional on the wire; `harness` and `binary_path` are what actually
select and launch the harness:

```json
{
  "harness": "claude-code",
  "binary_path": "/usr/local/bin/claude",
  "args": ["--some-flag"],
  "working_dir": "/path/to/project",
  "env": ["FOO=bar"],
  "cols": 120,
  "rows": 40,
  "effort": "high",
  "model": "opus",
  "permission_mode": "plan",
  "disable_codex_auto_dismiss": false,
  "auto_skip_codex_update_notice": false
}
```

→ `201 {"id": "<conversation id>"}`. The id **is** the chat session id, and is the
registry key.

#### `permission_mode`

The wrapper's third launch knob ([permission mode](wrapper.md#permission-mode)),
selecting the rung the harness starts on. **The gateway does not own the vocabulary** —
it neither restates the accepted values nor maps them to flags. It forwards the string
verbatim and delegates validation to the wrapper's own predicates, so the accepted set is
whatever the wrapper accepts today, per harness. Look it up there, not here.

`""` is indistinguishable from omitting the field: both leave the rung unset and inject
nothing.

> **An explicit permission flag in `args` WINS.** The mapping is all-or-nothing: if `args`
> already carries the harness's own permission flag, `permission_mode` injects nothing and
> the flag you passed stands. The request is still **accepted** — this is not a `400`. So
> `{"args": ["--permission-mode", "acceptEdits"], "permission_mode": "plan"}` launches with
> `acceptEdits`. Pass one or the other, not both.

> **codex `plan` is honoured in part.** It pins the **permissions** axis
> (`sandbox_mode="read-only"`, `approval_policy="untrusted"`) and leaves the
> **collaboration** axis unset — there is no launch flag for the latter, only a post-open
> step. On this route that is fine: the conversation is registered, so the
> `approval_prompt` that `approval_policy="untrusted"` produces surfaces on the SSE stream
> and a client answers it via `POST /v1/conversations/{id}/input`. (On `POST /v1/turns` it
> is not — see that section.)

The conversation is opened with a **background** context, not a request-scoped one — the
harness must outlive the HTTP request that started it.

Failure modes: `400 invalid_json`, `400 invalid_options`, `400 unknown_harness`,
`409 already_open` (a conversation already exists for that session id),
`503 shutting_down`.

`400 invalid_options` now also covers **unsupported launch-knob values**, pre-checked
before the harness is spawned rather than surfacing as an opaque `500`:

| Cause                                                    | `error`                                                |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `effort` value the wrapper does not accept               | `effort <v> is not supported`                          |
| `effort` on a harness without an effort knob             | `effort is not supported for harness <h>`              |
| `permission_mode` on a harness without a permission knob | `permission_mode is not supported for harness <h>`     |
| `permission_mode` value that harness does not accept     | `permission_mode <v> is not supported for harness <h>` |

Both pre-checks are **skipped when `harness` is absent**, so a body with no harness still
gets the honest presence error (`Harness and BinaryPath are required`) rather than being
blamed on a field it may not have sent.

> **Pass `working_dir` if you intend to read history.** It is optional on the wire, but
> for a harness with a transcript reader (Claude Code, Codex, pi) an empty working dir
> makes the reader throw `ErrEmptyWorkingDir` — which
> [`historyWithSource()`](../guides/reading-history.md) does **not** degrade to store
> history (it only falls back on `ErrSessionNotFound` / `ErrEmptySessionID`). The error
> propagates and `GET .../history` answers `500 history_failed`.

### `GET /v1/conversations`

→ `200` with an array of `{ "id", "harness", "session_id"? }`.

### `POST /v1/conversations/{id}/control`

No body. Blocks until the exclusive control token is granted, or until the client
disconnects (the request context is cancelled on `close`).

→ `200 {"token": "<32 hex chars>"}`.

### `POST /v1/conversations/{id}/messages`

```json
{
  "token": "<control token>",
  "text": "summarize this project",
  "timeout_seconds": 300
}
```

→ `202 {"turn_id": "<id>"}` — **accepted, not completed**. The turn's progress and
terminal state arrive on the SSE stream; `202` only means the harness took the input.

`timeout_seconds` (a meta-harness addition over the Go original) bounds the send as a
timed operation: exceeded → `504 timeout`, client disconnect → `408 canceled`.

### `POST /v1/conversations/{id}/input`

Answers a pending [input request](../guides/handling-input.md):

```json
{
  "token": "<control token>",
  "request_id": "<from the input_request event>",
  "option_id": "opt-2",
  "option_ids": ["opt-1", "opt-3"],
  "text": "free-text answer"
}
```

→ `204`. A non-empty `option_ids` (multi-select) **takes precedence** over `option_id`.
`option_ids` is a meta-harness superset field: without it multi-select prompts would be
unreachable over HTTP.

### `GET /v1/conversations/{id}/history`

→ `200 {"turns": [ <TurnDTO>, … ]}`. A store/read failure is `500 history_failed`.

### `GET /v1/conversations/{id}/screen`

A pure read — no token needed.

```json
{
  "text": "…rendered screen…",
  "cols": 120,
  "rows": 40,
  "cursor_col": 3,
  "cursor_row": 17,
  "generation": 42
}
```

### `GET /v1/conversations/{id}/permission-mode`

A pure read — no token needed, and it mutates nothing (no PTY write, no `/status`
keystroke, no store write). Unknown id → `404 not_found`.

```json
{
  "requested": "bypass",
  "requested_raw": "bypassPermissions",
  "observed": "acceptEdits",
  "raw": "Workspace (Approve for me)",
  "collaboration": "default",
  "source": "status",
  "generation": 12,
  "current_generation": 4711,
  "stale": true,
  "observed_at": "2026-07-22T18:04:11.220Z"
}
```

`requested`, `requested_raw`, `raw` and `collaboration` are **omitted when empty**.
That omission carries meaning: `observed: "unknown"` **with** a `raw` means the session
is in a state _outside_ the 5-rung ladder (a renamed mode, `Workspace (Approve for me)`),
while `observed: "unknown"` with **no** `raw` means "we could not see" — and `source`
says why (`no_footer`, `unparsed_footer`, `too_narrow`, `not_primed`, `not_written`,
`written_uncaptured`, or `launch` for a harness with no screen reader at all).

**Casing is mixed on purpose.** Only the KEYS are snake_case. `requested` / `observed`
carry the `PermissionRung` spelling verbatim (`"acceptEdits"`, camelCase) so they
round-trip back through the mode vocabulary unchanged; `source` carries the
prime-outcome vocabulary verbatim (`"written_uncaptured"`, snake_case).

`generation` is the screen generation the reading was **parsed from**;
`current_generation` is the generation of the frame the handler measured. Both come from
**one** snapshot, so a live claude footer read is never spuriously stale.

> `stale` is `current_generation !== generation` — **a generation comparison, not a
> liveness claim.** A live claude read is always `false`; a startup-cached codex
> `/status` box flips to `true` as soon as anything has been drawn since. A _closed_
> conversation would also report `false` (nothing writes after close, so the frozen
> frame matches itself), but that case cannot arise here: `DELETE /v1/conversations/{id}`
> removes the entry from the registry synchronously, so the route `404`s instead.

### `POST /v1/turns`

The stateless one-shot: open a harness, submit one prompt, wait for that turn to reach a
terminal state, stop the harness, and return the whole envelope in the response. No
conversation is registered and no control token is involved — this endpoint owns the
full lifecycle.

```json
{
  "harness": "claude-code",
  "binary_path": "/usr/local/bin/claude",
  "prompt": "summarize this project",
  "args": ["--some-flag"],
  "working_dir": "/path/to/project",
  "env": ["FOO=bar"],
  "cols": 120,
  "rows": 40,
  "effort": "high",
  "model": "opus",
  "permission_mode": "plan",
  "turn_harness": "codex",
  "exit_after_turn": true,
  "timeout_seconds": 900
}
```

`permission_mode` behaves as on `POST /v1/conversations` — same delegated vocabulary,
same `""`-is-unset rule, same explicit-`args`-wins precedence, and the same two
`400 invalid_options` causes (validated against `turn_harness || harness`, alongside the
identical pair for `effort`). **What differs is codex `plan`, and it differs badly enough
to be a usage requirement** — see the warning below.

`harness`, `binary_path`, and `prompt` are **required** — each missing one is its own
`400 invalid_options` (`"harness is required"`, …), validated up front rather than after
a spawn. `turn_harness` overrides which chat adapter interprets the turn.
`exit_after_turn` defaults to `true`; passing `false` is `400 unsupported` — the endpoint
is one-shot by definition.

`TurnConfig`'s function/policy-valued fields (`inputPolicy`, `onInputRequest`,
`eventBuffer`) are deliberately **not** wire-decoded. The run is unattended: the server
installs [`AutoAcceptTrust`](oneshot.md) to clear the trust prompt, and the bounded
context is the guard against every other input kind hanging.

> **A permission rung that gates approvals needs `timeout_seconds` on this route.**
> `AutoAcceptTrust` answers `trust_prompt` and **nothing else** — it carries no default
> disposition — and this endpoint registers no conversation, so it exposes no `/input`
> route through which a caller could answer anything either. A codex rung that sets
> `approval_policy="untrusted"` (`plan`, `manual`) therefore produces an `approval_prompt`
> that **nobody can answer**: the run stays open until the client disconnects
> (`408 canceled`). Pass `timeout_seconds` to bound it into an honest `504 timeout`, or
> use `POST /v1/conversations`, where a client answers the prompt for real.
>
> This is not a rejection: a turn that only reads never trips an approval gate and
> completes normally under the read-only sandbox, which is the deterministic and genuinely
> useful half of the rung. The gateway does not second-guess which it will be.
>
> The `plan` rung's **collaboration** axis stays permanently unset here regardless —
> setting it is a post-open step, and one-shot is unattended by construction.

→ `200` with the turn-result envelope:

```ts
{ turn: TurnDTO,
  session: SessionDTO,
  history: TurnDTO[],
  history_source: "transcript" | "store",
  process_stopped_after_turn: boolean,
  error?: string }
```

**An errored turn is still `200`.** The envelope carries the errored turn plus an `error`
string; only infrastructure failures produce a non-2xx. Check `turn.state` — not the HTTP
status — to decide whether the turn succeeded.

The run is bounded by a **request-scoped** context (unlike `POST /v1/conversations`,
which opens with a background context), so `timeout_seconds` and a client disconnect
genuinely abort a wedged run: `504 timeout` / `408 canceled`.

> **Budget for the quit floor.** A _completed_ run pays `runTurn`'s ~3 s graceful-quit
> before responding. An errored turn skips it and returns faster. Client-side timeouts
> must account for that floor on top of the turn itself.

---

## The event stream (SSE)

```
GET /v1/conversations/{id}/events
```

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, and `X-Accel-Buffering: no` (defeats nginx buffering). Frames:

```
data: {"type":"turn","turn":{…}}

: ping

data: {"type":"input_request","input":{…}}
```

- Each event is one `data: <JSON>\n\n` frame. There are no named SSE `event:` types —
  discriminate on the envelope's `type`.
- `: ping\n\n` is a comment heartbeat every **15 s**, so idle connections and proxies
  stay open.
- The stream ends when the conversation's event source closes, or when the request or
  response closes.

### Envelope

```ts
{ type: "turn" | "input_request" | "input_resolved",
  turn?:  TurnDTO,          // present for type="turn"
  input?: InputRequestDTO,  // present for the two input types
  error?: string }          // out-of-band error (e.g. a Store failure)
```

### Delivery guarantees

The daemon builds the per-conversation fanout **eagerly at open**, before any subscriber
exists, because `Conversation.events()` is a single-consumer channel — the fanout is its
sole drainer.

- **Nothing is lost before the first attach.** Events emitted between open and the first
  `GET /events` are buffered and replayed to that first subscriber.
- **Later subscribers start from now.** The replay buffer is dropped once the first
  subscriber attaches; a second client sees only events from its own subscription point.
- **Slow consumers drop, they don't stall.** Each subscriber has a 64-event ring; when it
  is full, further events are dropped for _that_ subscriber rather than blocking the
  drainer or its siblings. There is no `Last-Event-ID` resume — reconcile with
  `GET /history` after a reconnect.

---

## Wire conventions

The DTOs are wire-compatible with the Go `cmd/harness-chatd` original, so existing Go
clients talk to this daemon unchanged:

- **`snake_case` JSON**, not meta-harness's internal camelCase.
- **Timestamps** are RFC3339/ISO strings. `completed_at` is **omitted** while a turn is
  incomplete.
- **`retry_after` is a Go duration string** (`"30s"`, `"1m30s"`, `"1.5s"`), even though
  `Turn.retryAfter` is a number of milliseconds internally. Zero is omitted.
- **Empty/zero fields are omitted**, not sent as `null`.

Two fields are meta-harness supersets that the Go original lacks — additive, so Go
compatibility holds: `InputRequestDTO.header` / `.multi_select` (plus each option's
`description`), and the `option_ids[]` answer field.

### `TurnDTO`

```ts
{ id, session_id, role, state,      // state: "pending"|"streaming"|"complete"|"errored"
  text?, reason?,
  started_at, completed_at?,
  http_code?,                        // upstream API status, when the turn carries one
  retry_after? }                     // Go duration string
```

### `InputRequestDTO`

```ts
{ id, kind, prompt,                  // kind: "trust_prompt"|"question"|"question_review"|"approval_prompt"
  options?: [{ id, alias?, label, description? }],
  header?, multi_select? }
```

---

## Errors

Chat sentinels map to HTTP through an explicit ordered table
([`src/gateway/errors.ts`](../../../src/gateway/errors.ts)):

| Sentinel               | Status | `code`                |
| ---------------------- | ------ | --------------------- |
| `ErrNoControl`         | `409`  | `no_control`          |
| `ErrTurnInFlight`      | `409`  | `turn_in_flight`      |
| `ErrInputPending`      | `409`  | `input_pending`       |
| `ErrNoInputPending`    | `409`  | `no_input_pending`    |
| `ErrStaleInputRequest` | `409`  | `stale_input_request` |
| `ErrClosed`            | `410`  | `gone`                |
| `ErrUnknownHarness`    | `400`  | `unknown_harness`     |
| `ErrInvalidOptions`    | `400`  | `invalid_options`     |
| `ErrUnknownOption`     | `400`  | `unknown_option`      |
| `ErrNotMultiSelect`    | `400`  | `not_multi_select`    |
| _anything else_        | `500`  | `internal`            |

The timed paths (`messages`, `input`) map the context sentinels **first**:
`ctxDeadlineExceeded` → `504 timeout`, `ctxCanceled` → `408 canceled`.

Matching walks the error `cause` chain by sentinel code — never match on message text.

The daemon's own (non-sentinel) errors are `400 invalid_json`, `400 invalid_options`
(on **both** `POST /v1/turns` and `POST /v1/conversations`: a missing required field, or
an unsupported `effort` / `permission_mode` value or harness), `400 unsupported`, `404 not_found`, `404 unknown_token`,
`409 already_open`, `409 no_control`, `500 history_failed`, `503 shutting_down`.

Every error — sentinel-mapped or not — uses Go's `errorResponse` body:

```json
{ "error": "human-readable message", "code": "stable_machine_code" }
```

Branch on `code`; treat `error` as prose that may change.

---

## Worked examples

### One-shot (`/v1/turns`) — the path that works today

```bash
BASE=http://127.0.0.1:8080

curl -sS -X POST $BASE/v1/turns \
  -H 'content-type: application/json' \
  -d '{"harness":"claude-code",
       "binary_path":"/usr/local/bin/claude",
       "working_dir":"'"$PWD"'",
       "prompt":"summarize this project",
       "timeout_seconds":900}' | jq '{state: .turn.state, text: .turn.text, error}'
```

One request, one response, no tokens and no stream. Remember that an errored turn also
returns `200` — branch on `.turn.state`.

### Multi-turn conversation

> Blocked by the open defect noted at the top of this page — shown for the shape.

```bash
BASE=http://127.0.0.1:8080

# 1. open — spawns the harness
ID=$(curl -sS -X POST $BASE/v1/conversations \
  -H 'content-type: application/json' \
  -d '{"harness":"claude-code","binary_path":"/usr/local/bin/claude","working_dir":"'"$PWD"'"}' \
  | jq -r .id)

# 2. subscribe BEFORE sending (or rely on the replay buffer)
curl -sSN $BASE/v1/conversations/$ID/events &

# 3. take control
TOK=$(curl -sS -X POST $BASE/v1/conversations/$ID/control | jq -r .token)

# 4. send — 202, the result arrives on the stream
curl -sS -X POST $BASE/v1/conversations/$ID/messages \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOK\",\"text\":\"summarize this project\",\"timeout_seconds\":300}"

# 5. read the settled turns, then tear down
curl -sS $BASE/v1/conversations/$ID/history | jq .
curl -sS -X DELETE $BASE/v1/conversations/$ID/control/$TOK
curl -sS -X DELETE $BASE/v1/conversations/$ID
```

Wait for the SSE frame whose `turn.state` is `complete` or `errored` before treating the
turn as settled — `202` is acceptance, not completion.

---

## See also

- [chat](chat.md) — the in-process API this daemon wraps; the same control/turn
  semantics, without the HTTP hop.
- [Handling input](../guides/handling-input.md) — the prompt kinds behind
  `input_request` and how answers resolve.
- [cli](cli.md) / [wrapper-cli](wrapper-cli.md) — in-process one-shot alternatives when
  you do not need a live session or a network hop.
- [Pluggable environments](../../env/README.md) — sandboxed execution, the right tool
  when the caller is not fully trusted.
