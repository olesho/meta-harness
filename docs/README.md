# Documentation

meta-harness documentation comes in two forms:

- **[Markdown](md/README.md)** — the full written docs: getting-started, architecture,
  concepts, a per-module API reference, and task guides. This is the source of truth.
  Start at **[`md/README.md`](md/README.md)**.
- **[HTML](html/index.html)** — a single self-contained page with SVG diagrams of the
  layered architecture and the turn-signal flow, plus the harness support matrix. Best
  viewed rendered in a browser (GitHub shows it as source).

## Layout

```
docs/
  md/                       Markdown documentation (source of truth)
    README.md                 documentation home
    getting-started.md        install, build, first turn
    architecture.md           layers, boundaries, packaging
    concepts.md               the shared vocabulary
    harnesses.md              the support matrix
    modules/                  per-module API reference
    guides/                   task-oriented walkthroughs
  html/                     rendered visual overview
    index.html
```
