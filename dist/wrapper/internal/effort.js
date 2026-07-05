// Per-harness reasoning-effort translation: CLI args (Claude --effort, Codex
// -c model_reasoning_effort).
import { argsContainConfigKey, argsContainFlag, normHarness, prependArgs, } from "./harnessargs.js";
export function isSupportedEffort(effort) {
    switch (effort) {
        case "low":
        case "medium":
        case "high":
        case "xhigh":
        case "max":
            return true;
        default:
            return false;
    }
}
export function harnessSupportsEffort(harness) {
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
        case "codex":
            return true;
        default:
            return false;
    }
}
function codexEffort(effort) {
    return effort === "max" ? "xhigh" : effort;
}
/** Prepend a per-harness effort flag/config override. An existing one wins. */
export function argsWithHarnessEffort(harness, args, effort) {
    if (effort === "")
        return args;
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
            if (argsContainFlag(args, "--effort"))
                return args;
            return prependArgs(args, "--effort", effort);
        case "codex":
            if (argsContainConfigKey(args, "model_reasoning_effort"))
                return args;
            return prependArgs(args, "-c", `model_reasoning_effort="${codexEffort(effort)}"`);
        default:
            return args;
    }
}
//# sourceMappingURL=effort.js.map