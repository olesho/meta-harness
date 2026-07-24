---
name: veracity
description: Operate this veracity-managed project — add projects, toggle features, regenerate docs/diagrams, and verify. Use when working in a repo that contains veracity.lock.json.
---

# veracity (project operations)

This repo is managed by the `veracity` CLI (pinned in `.veracity-version`).

- **Verify** the tree matches the lock: `veracity verify`.
- **Lint / test**: `veracity lint`, `veracity test` (a project, or all).
- **Docs**: `veracity docs markdown` (structural, auto on Stop); `veracity docs diagrams <project>` (architecture SVG, manual — uses an LLM to write module/interface prose).
- **Grow** (monorepo): `veracity add`. **Toggle features**: `veracity edit <name> --confirm <name>`.
- **Restore** managed wiring after a hand-edit: `veracity restore`.

Do not hand-edit files under `hooks/`, `.claude/`, or `.codex/` — veracity manages
them, and the Stop hook and git gates now **block** on drift. If you edited one,
run `veracity restore` to discard the edit; to change wiring for real, change what
generates it (`veracity edit` / `veracity reconfigure`). Your source and native lint
config are yours to edit.
