# meta-harness

TypeScript project wired to [Orche](../../new/orche) for autonomous plan → ship → release → redeploy.

## Develop

```bash
bun install
bun test        # the release gate (ORCHE_RELEASE_GATE_CMD)
```

## Orche

This project is wired to the `META-HARNESS` fleet-db workspace via the
`autonomous-dev-deploy` pipeline. See `.orche/config.json` and `.env`. Ship a plan
from Claude Code with "ship this plan", or check agents with "are the agents running?".
