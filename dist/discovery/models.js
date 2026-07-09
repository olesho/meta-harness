// Model discovery and selection for the supported harnesses.
//
// Neither `claude` nor `codex` exposes a machine-readable "list models" CLI
// flag — the only enumerator is the interactive `/model` slash command, which
// renders a picker inside a live session. This module therefore has two halves:
//
//   - parseModelPicker() — the pure, testable heart: given a rendered
//     `/model` picker screen (a Screen.snapshot().text), return the models it
//     lists. Deterministically tested against recorded corpus fixtures.
//   - discoverModels() — the live driver: open a harness, send `/model`, poll
//     the screen until the picker renders, then parse it.
//
// Selection stays flag-based via the wrapper's argsWithHarnessModel; this
// module adds isKnownModel()/knownModels() for validating a chosen model
// against a curated static list (models.json), which works offline without
// launching a CLI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Open, newMemStore, } from "../chat/index.js";
import { Context } from "../internal/async/index.js";
import { normHarness } from "../wrapper/internal/harnessargs.js";
// A picker row: optional cursor marker (❯ / › / *), an index, then a
// two-column "label  description" split on a run of 2+ spaces.
const rowRe = /^\s*[❯›*]?\s*\d+\.\s+(.+?)\s{2,}(\S.*?)\s*$/u;
/** Picker header text that must be present for a screen to be treated as a `/model` picker. */
function pickerHeader(harness) {
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
            return /Select model/i;
        case "codex":
            return /Select Model and Effort/i;
        default:
            return null;
    }
}
/**
 * parseModelPicker extracts the model list from a rendered `/model` picker
 * screen. `text` is a Screen.snapshot().text (one line per row). Returns [] for
 * an unsupported harness or a screen that is not a model picker (so a stray
 * numbered list elsewhere on screen never yields false positives).
 */
export function parseModelPicker(text, harness) {
    const header = pickerHeader(harness);
    if (header === null || !header.test(text))
        return [];
    const kind = normHarness(harness);
    const out = [];
    for (const line of text.split("\n")) {
        const m = rowRe.exec(line);
        if (!m)
            continue;
        const rawLabel = m[1].trim();
        const description = m[2].trim();
        if (kind === "codex") {
            const current = /\(current\)/i.test(rawLabel);
            const isDefault = /\(default\)/i.test(rawLabel);
            // "gpt-5.4-mini (current)" → id/label "gpt-5.4-mini".
            const id = rawLabel.replace(/\([^)]*\)/g, "").trim().split(/\s+/)[0] ?? "";
            if (id === "")
                continue;
            out.push({ id, label: id, description, current, isDefault });
        }
        else {
            // claude-code: "Opus ✔" (active) / "Default (recommended)" (default).
            const current = /✔/.test(rawLabel);
            const cleaned = rawLabel.replace(/✔/g, "").trim();
            const isDefault = /^Default\b|\(recommended\)/i.test(cleaned);
            // The picker's short name is the `--model` alias, case-insensitively.
            const id = (cleaned.split(/\s+/)[0] ?? "").toLowerCase();
            if (id === "")
                continue;
            out.push({ id, label: cleaned, description, current, isDefault });
        }
    }
    return out;
}
const embeddedPath = join(dirname(fileURLToPath(import.meta.url)), "models.json");
const registry = JSON.parse(readFileSync(embeddedPath, "utf8"));
/** Canonical registry key ("claude" → "claude-code", so both resolve alike). */
function registryKey(harness) {
    const h = normHarness(harness);
    return h === "claude" ? "claude-code" : h;
}
/** The curated list of known model ids/aliases for a harness, or [] if unknown. */
export function knownModels(harness) {
    const e = registry[registryKey(harness)];
    return e ? [...e.models] : [];
}
/** The curated default model id for a harness, or "" if unknown. */
export function defaultModel(harness) {
    return registry[registryKey(harness)]?.default ?? "";
}
/**
 * isKnownModel reports whether `model` is in the curated list for `harness`
 * (case-insensitive). It is a validation *helper*, not a gate: the wrapper still
 * forwards any free-form model string, so a brand-new model id absent from the
 * list is not rejected — callers opt into this check when they want it.
 */
export function isKnownModel(harness, model) {
    const want = model.trim().toLowerCase();
    if (want === "")
        return false;
    return knownModels(harness).some((m) => m.toLowerCase() === want);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * discoverModels launches the harness, sends the `/model` slash command, waits
 * for the picker to render, and returns the models it lists. It is read-only: it
 * never selects a model in the picker — it dismisses the session on close.
 * Throws if the harness is unsupported or the picker never renders in time.
 */
export async function discoverModels(ctx, opts) {
    if (pickerHeader(opts.harness) === null) {
        throw new Error(`discoverModels: unsupported harness ${JSON.stringify(opts.harness)}`);
    }
    const conv = await Open(ctx, {
        harness: opts.harness,
        binaryPath: opts.binaryPath,
        workingDir: opts.workingDir,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows,
        store: newMemStore(),
    });
    try {
        const release = await conv.acquireControl(ctx);
        try {
            await conv.send(ctx, "/model");
        }
        finally {
            release();
        }
        const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
        for (;;) {
            const models = parseModelPicker(conv.screenSnapshot().text, opts.harness);
            if (models.length > 0)
                return models;
            if (Date.now() >= deadline) {
                throw new Error("discoverModels: /model picker did not render before timeout");
            }
            await sleep(150);
        }
    }
    finally {
        const { ctx: closeCtx } = Context.withDeadline(Context.background(), 2000);
        await conv.close(closeCtx).catch(() => { });
    }
}
//# sourceMappingURL=models.js.map