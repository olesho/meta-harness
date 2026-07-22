// Shared helpers for translating per-harness CLI args (effort, model).
/** Normalize a harness name for switch matching ("claude-code" → matches "claude"). */
export function normHarness(h) {
    return (h ?? "").trim().toLowerCase();
}
export function prependArgs(args, ...prefix) {
    return [...prefix, ...args];
}
// NOTE (deliberate, do not "fix" here): argsContainFlag matches the EXACT
// token only, while Go's effort/model guards use the three-spelling matcher
// (argsContainAnyFlag). So effort.ts's `--effort` guard and model.ts's
// `--model` guard are weaker than Go's on `--effort=high` / `--model=x`. That
// is a pre-existing effort/model divergence, NOT a permission-mode one, and it
// belongs in its own ticket. Do not widen argsContainFlag here, and do not
// freeze the current behaviour here either.
export function argsContainFlag(args, flag) {
    return args.includes(flag);
}
/**
 * isShortFlag reports whether flag is a single-dash, single-letter flag
 * (matching /^-[a-z]$/) — the only shape for which clap accepts an attached
 * value with no separator ("-sread-only").
 */
function isShortFlag(flag) {
    return /^-[a-z]$/.test(flag);
}
/**
 * argsContainAnyFlag reports whether args already carry any of flags, in any
 * of the three spellings a caller can write: the bare token ("-s"), the
 * attached long form ("--sandbox=read-only"), and clap's attached SHORT form
 * ("-sread-only"). Sibling of argsContainFlag, which matches the exact token
 * only.
 *
 * The attached-short-form rule is a PREFIX match, so it also matches any
 * hypothetical single-dash token that merely begins with "-s"/"-a" (e.g.
 * "-auto-something"). codex/clap expose no such flag today, and the failure
 * direction is one-sided: a false positive SUPPRESSES injection (the caller's
 * argv is left exactly as written) rather than emitting a second -s/-a. It is
 * still a silent drop of the requested mode, so it is called out here.
 */
export function argsContainAnyFlag(args, flags) {
    for (const arg of args) {
        for (const flag of flags) {
            if (arg === flag || arg.startsWith(flag + "="))
                return true;
            if (isShortFlag(flag) && arg.length > 2 && arg.startsWith(flag)) {
                return true;
            }
        }
    }
    return false;
}
/**
 * flagValue extracts the operand of the LAST occurrence of any of names, in
 * each of the spellings argsContainAnyFlag recognizes: the attached long form
 * ("--permission-mode=plan"), clap's attached short form ("-sread-only") and
 * the separated form ("--permission-mode plan"), which argsContainAnyFlag
 * cannot read at all.
 *
 * LAST occurrence, not first, mirroring claude's and clap's own last-wins
 * parsers: on a duplicated flag the harness launches at the LATER value, so
 * reporting the earlier one would under-report permissiveness — the one
 * direction a safety field must never fail in. Injection is unaffected: it
 * only runs when argv carries none of these flags and then emits exactly one,
 * so first and last coincide.
 *
 * The boolean reports PRESENCE, exactly as argsContainAnyFlag would. A
 * present-but-unreadable flag (trailing, no operand) returns ["", true] — the
 * caller must distinguish that from ["", false] only if absence and unknown
 * differ to it; effectiveLaunchRung maps both to "".
 */
export function flagValue(args, ...names) {
    let value = "";
    let found = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        for (const flag of names) {
            if (arg === flag) {
                value = i + 1 < args.length ? args[i + 1] : "";
            }
            else if (arg.startsWith(flag + "=")) {
                value = arg.slice(flag.length + 1);
            }
            else if (isShortFlag(flag) && arg.length > 2 && arg.startsWith(flag)) {
                value = arg.slice(flag.length);
            }
            else {
                continue;
            }
            found = true;
        }
    }
    return [value, found];
}
function configArgHasKey(arg, key) {
    const a = arg.trim();
    return a === key || a.startsWith(key + "=");
}
/** Strip ONE matched pair of surrounding `"` or `'` from a config value. */
function stripQuotes(value) {
    if (value.length >= 2) {
        const q = value[0];
        if ((q === '"' || q === "'") && value.endsWith(q)) {
            return value.slice(1, -1);
        }
    }
    return value;
}
/** Resolve one `-c` operand against key, returning [value, matched]. */
function configArgValue(arg, key) {
    const a = arg.trim();
    if (a === key)
        return ["", true];
    if (a.startsWith(key + "="))
        return [stripQuotes(a.slice(key.length + 1)), true];
    return ["", false];
}
/**
 * configKeyValue extracts the value of a `-c key=value` config override, in
 * the same four spellings argsContainConfigKey recognizes: "-c k=v", "-ck=v",
 * "--config k=v" and "--config=k=v".
 *
 * LAST-wins, like flagValue and like codex's own silent `-c` last-wins
 * resolution. ONE matched pair of surrounding `"` or `'` is stripped: this
 * repo emits the quoted form (`effort.ts` / `model.ts` write `key="value"`),
 * so an un-stripped read would never compare equal to a bare value.
 *
 * The boolean reports PRESENCE. A key with no `=` ("-c sandbox_mode") is
 * present with an empty value.
 */
export function configKeyValue(args, key) {
    let value = "";
    let found = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        let operand;
        if (arg === "-c" || arg === "--config") {
            operand = i + 1 < args.length ? args[i + 1] : "";
        }
        else if (arg.startsWith("-c") && arg.length > 2) {
            operand = arg.slice(2);
        }
        else if (arg.startsWith("--config=")) {
            operand = arg.slice("--config=".length);
        }
        if (operand === undefined)
            continue;
        const [v, ok] = configArgValue(operand, key);
        if (!ok)
            continue;
        value = v;
        found = true;
    }
    return [value, found];
}
export function argsContainConfigKey(args, key) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-c" || arg === "--config") {
            if (i + 1 < args.length && configArgHasKey(args[i + 1], key))
                return true;
            continue;
        }
        if (arg.startsWith("-c") &&
            arg.length > 2 &&
            configArgHasKey(arg.slice(2), key)) {
            return true;
        }
        if (arg.startsWith("--config=") &&
            configArgHasKey(arg.slice("--config=".length), key)) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=harnessargs.js.map