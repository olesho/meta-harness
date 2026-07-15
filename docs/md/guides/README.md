# Guides

Task-oriented walkthroughs that cut across modules. For the API of a single layer, see
the [module reference](../modules/); for the mental model, [Concepts](../concepts.md).

| Guide | You want to… |
| --- | --- |
| [Building a conversation](conversation.md) | Drive a multi-turn, interactive session end to end. |
| [One-shot turns](one-shot-turns.md) | Run a single prompt → reply, in-process or via the CLI. |
| [Resuming sessions](resuming-sessions.md) | Continue a prior harness session with `resume` / `Reopen`. |
| [Reading history](reading-history.md) | Get conversation history and know its source (transcript vs store). |
| [Handling input requests](handling-input.md) | Resolve trust dialogs, prompts, and mid-turn clarifying questions — automatically or interactively. |
| [Adding a harness](adding-a-harness.md) | Teach meta-harness a new coding agent. |

All examples assume:

```ts
import { Context } from "meta-harness/async"
```

and that you have a harness binary available (check with
[`discovery`](../modules/discovery.md)).
