---
name: veracity-docs
description: Refresh the architecture-diagram prose (module summaries and interface descriptions) for a veracity-managed project. Use when `veracity docs status` reports pending items, when the Stop hook notes stale summaries, or when the user asks to update the module/interface documentation or diagrams.
---

# veracity-docs

The `veracity` CLI extracts modules and interfaces from the AST and renders
Markdown + HTML + SVG deterministically. It does **not** call an LLM — you (the
running agent) write the prose. Your prose is cached by content hash, so it is
only needed when code changes.

## Procedure

1. **Get the structures and what's pending.** Run:

   ```sh
   veracity docs status --json           # single-project repo
   veracity docs status --json <name>    # monorepo: name the project
   ```

   The JSON lists modules (id, name, path, doc comments, exports) and each
   module's interfaces (name, methods, doc comments). Items with
   `"needsSummary": true` / `"needsDescription": true` need prose from you.

2. **Write grounded prose.** `veracity docs status --template` prints a
   ready-to-fill payload containing exactly the pending items with the right
   keys. For each pending module, write a 1–3 sentence `summary` of what it is
   responsible for — grounded ONLY in its name, path, doc comments, exported
   signatures, and interfaces. For each pending interface, write a 1–2 sentence
   description of the contract it represents for callers. Do not invent behavior
   or rename anything.

3. **Submit the prose** (validated against the current IR; unknown ids are
   rejected). `modules` is an object keyed by module id (an array of
   `{"id":...}` objects is also accepted):

   ```sh
   printf '%s' '{
     "modules": {
       "<module-id>": {
         "summary": "…",
         "interfaces": { "<InterfaceName>": "…" }
       }
     }
   }' | veracity docs enrich --from -            # add <name> for monorepo
   ```

4. **Render** the docs and diagrams:

   ```sh
   veracity docs render                          # add <name> for monorepo
   ```

   This writes `docs/MODULES.md`, `docs/modules.html`, and `docs/modules.svg`.
