import { Context } from "../internal/async/index.ts";
/** One model as listed by a harness's `/model` picker. */
export interface ModelInfo {
    /** The value to pass to the wrapper's model selection (`--model` / `-c model=`). */
    id: string;
    /** The human-facing label shown in the picker (e.g. "Opus", "gpt-5.4-mini"). */
    label: string;
    /** The one-line description shown beside the label, when present. */
    description: string;
    /** True for the harness's currently-active model. */
    current: boolean;
    /** True for the model the picker marks as the default / recommended pick. */
    isDefault: boolean;
}
/**
 * parseModelPicker extracts the model list from a rendered `/model` picker
 * screen. `text` is a Screen.snapshot().text (one line per row). Returns [] for
 * an unsupported harness or a screen that is not a model picker (so a stray
 * numbered list elsewhere on screen never yields false positives).
 */
export declare function parseModelPicker(text: string, harness: string): ModelInfo[];
/** The curated list of known model ids/aliases for a harness, or [] if unknown. */
export declare function knownModels(harness: string): string[];
/** The curated default model id for a harness, or "" if unknown. */
export declare function defaultModel(harness: string): string;
/**
 * isKnownModel reports whether `model` is in the curated list for `harness`
 * (case-insensitive). It is a validation *helper*, not a gate: the wrapper still
 * forwards any free-form model string, so a brand-new model id absent from the
 * list is not rejected — callers opt into this check when they want it.
 */
export declare function isKnownModel(harness: string, model: string): boolean;
/** Options for {@link discoverModels}. Mirrors the chat/oneshot launch surface. */
export interface DiscoverModelsOptions {
    harness: string;
    binaryPath: string;
    workingDir?: string;
    env?: string[];
    cols?: number;
    rows?: number;
    /** How long to wait for the picker to render before giving up (ms). Default 15000. */
    timeoutMs?: number;
}
/**
 * discoverModels launches the harness, sends the `/model` slash command, waits
 * for the picker to render, and returns the models it lists. It is read-only: it
 * never selects a model in the picker — it dismisses the session on close.
 * Throws if the harness is unsupported or the picker never renders in time.
 */
export declare function discoverModels(ctx: Context, opts: DiscoverModelsOptions): Promise<ModelInfo[]>;
//# sourceMappingURL=models.d.ts.map