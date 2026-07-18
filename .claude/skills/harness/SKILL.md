---
name: harness
description: Operate this harness-managed project — add projects, toggle features, regenerate docs/diagrams, and verify. Use when working in a repo that contains harness.lock.json.
---

# harness (project operations)

This repo is managed by the `harness` CLI (pinned in `.harness-version`).

- **Verify** the tree matches the lock: `harness verify`.
- **Lint / test**: `harness lint`, `harness test` (a project, or all).
- **Docs**: `harness docs markdown` (structural, auto on Stop); `harness docs diagrams <project>` (architecture SVG, manual — uses an LLM to write module/interface prose).
- **Grow** (monorepo): `harness add`. **Toggle features**: `harness edit <name> --confirm <name>`.
- **Upgrade** the pinned harness + reconcile managed wiring: `harness upgrade`.

Do not hand-edit files under `hooks/`, `.claude/`, or `.codex/` — harness manages
them. Your source and native lint config are yours to edit.
