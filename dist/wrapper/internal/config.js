// Wrapper configuration, validation, and wrapper-level sentinel errors.
//
// PTY supervision (Session/Run) is out of scope for the classifier core; this
// module ports only the config surface those entry points validate against,
// plus the cause-chain sentinels callers test with isSentinel.
import { defineSentinel, isSentinel, wrap } from "../../internal/async/errors.js";
import { harnessSupportsEffort, isSupportedEffort } from "./effort.js";
/**
 * Wrapper-level sentinel errors. Callers use isSentinel(err, X) to distinguish
 * wrapper failures from harness outcomes — the cause-chain analogue of Go's
 * errors.Is with the package's sentinel vars.
 */
export const ErrInvalidConfig = defineSentinel("wrapper:invalid-config", "wrapper: invalid config");
export const ErrBinaryNotFound = defineSentinel("wrapper:binary-not-found", "wrapper: binary not found");
/**
 * Validate a config, returning an Error (wrapping ErrInvalidConfig) on failure
 * or null when the config is acceptable to Start.
 */
export function validateConfig(cfg) {
    if (!cfg.binaryPath) {
        return wrap("wrapper: invalid config: BinaryPath is required", ErrInvalidConfig);
    }
    if (cfg.stdout == null) {
        return wrap("wrapper: invalid config: Stdout is required", ErrInvalidConfig);
    }
    const idleClassify = cfg.idleClassify ?? 0;
    const idleQuiet = cfg.idleQuiet ?? 0;
    const staleThreshold = cfg.staleThreshold ?? 0;
    if (idleClassify > 0 && idleQuiet > 0 && idleClassify < idleQuiet) {
        return wrap(`wrapper: invalid config: IdleClassify (${idleClassify}) must be >= IdleQuiet (${idleQuiet})`, ErrInvalidConfig);
    }
    if (staleThreshold > 0 && idleClassify > 0 && staleThreshold < idleClassify) {
        return wrap(`wrapper: invalid config: StaleThreshold (${staleThreshold}) must be >= IdleClassify (${idleClassify})`, ErrInvalidConfig);
    }
    if (cfg.effort && cfg.effort !== "") {
        if (!isSupportedEffort(cfg.effort)) {
            return wrap("wrapper: invalid config: Effort must be one of low, medium, high, xhigh, max", ErrInvalidConfig);
        }
        if (!harnessSupportsEffort(cfg.harness ?? "")) {
            return wrap("wrapper: invalid config: Effort is only supported for claude and codex harnesses", ErrInvalidConfig);
        }
    }
    return null;
}
/** Report whether err indicates the configured harness binary was not found. */
export function isBinaryNotFound(err) {
    if (isSentinel(err, ErrBinaryNotFound))
        return true;
    // Node's spawn surfaces a missing executable as ENOENT.
    let cur = err;
    const seen = new Set();
    while (cur && typeof cur === "object" && !seen.has(cur)) {
        seen.add(cur);
        if (cur.code === "ENOENT")
            return true;
        cur = cur.cause;
    }
    return false;
}
//# sourceMappingURL=config.js.map