// Per-harness model override translation (Claude Code --model, Codex
// -c model="…"). The "mode" policy layer selects a model; this applies it to
// the harness CLI args. An explicit model flag already in args wins.
import { argsContainConfigKey, argsContainFlag, normHarness, prependArgs, } from "./harnessargs.js";
/** Prepend a per-harness model override. Empty leaves the harness default. */
export function argsWithHarnessModel(harness, args, model) {
    if (model === "")
        return args;
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
            if (argsContainFlag(args, "--model"))
                return args;
            return prependArgs(args, "--model", model);
        case "codex":
            if (argsContainConfigKey(args, "model"))
                return args;
            return prependArgs(args, "-c", `model="${model}"`);
        default:
            return args;
    }
}
//# sourceMappingURL=mode.js.map