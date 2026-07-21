# Module reference

Each layer of meta-harness is a separately importable subpath. This is the API reference;
for how they fit together see [Architecture](../architecture.md), and for the shared
vocabulary see [Concepts](../concepts.md).

Modules are listed bottom-up (substrate first). Every public symbol named here is frozen
by [`test/contract.test.ts`](../../../test/contract.test.ts), so it matches what ships.

| Module                               | Import                       | Role                                                                                                    |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| [async](async.md)                    | `meta-harness/async`         | The public `Context` cancellation/deadline primitive.                                                   |
| [screen](screen.md)                  | `meta-harness/screen`        | Headless VT100 emulator → `Snapshot`s + change notifications.                                           |
| [wrapper](wrapper.md)                | `meta-harness/wrapper`       | PTY supervision + output/exit classification into `Status`/`ErrorClass`.                                |
| [turns](turns.md)                    | `meta-harness/turns`         | Per-harness turn-detection adapters + a `Watcher`.                                                      |
| [transcript](transcript.md)          | `meta-harness/transcript`    | Parse a harness's on-disk log into a canonical `Event` stream.                                          |
| [hooks](hooks.md)                    | `meta-harness/hooks`         | Manage a harness's hook config (`ensureSettingsJSONHooks`, `renderHookCommand`) + parse hook payloads.  |
| [chat](chat.md)                      | `meta-harness/chat`          | The `Conversation`: one supervised harness + a chat API.                                                |
| [oneshot](oneshot.md)                | `meta-harness/oneshot`       | Prompt → single reply → teardown, atop chat.                                                            |
| [cli](cli.md)                        | `meta-harness-run`           | The one-shot loop as a disposable process.                                                              |
| [wrapper-cli](wrapper-cli.md)        | `meta-harness-wrapper`       | Foreground TTY passthrough + tmux-detached subcommands + delegated one-shot `run`.                      |
| [discovery](discovery.md)            | `meta-harness/discovery`     | Probe installed harness CLIs and their versions.                                                        |
| [versions](versions.md)              | `meta-harness/versions`      | The pinned harness-version catalog.                                                                     |
| [env](../../env/README.md)           | `meta-harness/env`           | Pluggable sandboxed environments: Provisioner × Containment, credential injectors, `runStructuredTurn`. |
| [env-openshell](../../env/README.md) | `meta-harness/env-openshell` | OpenShell containment backend: kernel-level isolation + `generatePolicy` egress policy.                 |
| [env-daytona](../../env/README.md)   | `meta-harness/env-daytona`   | Daytona cloud provisioner backend + the `sweep()` orphan reaper.                                        |

The three `env*` modules share one canonical doc: [Pluggable
environments](../../env/README.md) (`docs/env/README.md`).

The package root `meta-harness` (`src/index.ts`) exports only `VERSION` — everything real
lives under a subpath.

## Conventions used in these docs

- **Signatures** are the actual TypeScript, quoted from source. `[T, boolean]` tuple
  returns are the Go `(value, ok)` idiom.
- **Sentinels** (`ErrX`) are identity-comparable error objects; test them with the
  provided predicates or `isSentinel` from the internal toolkit — never by message.
- A `ctx: Context` first parameter comes from [`meta-harness/async`](async.md) and
  carries cancellation/deadline.
