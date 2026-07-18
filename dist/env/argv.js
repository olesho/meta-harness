// Injection-safe argv → shell string (loomcli Part C's `argvToShell` discipline).
//
// Any place a prompt or user string crosses an exec boundary that is
// shell-interpreted (e.g. a containment's in-guest `env K=V <argv>` prefix), the
// argv must be reassembled with STRICT single-quoting so no metacharacter,
// newline, or leading dash can break out of its token. Unit-tested against
// hostile inputs.
/** Single-quote one argument for POSIX `sh`.
 *
 *  Empty string → `''`. Otherwise wrap in single quotes and escape any embedded
 *  single quote via the `'\''` idiom (close-quote, escaped-quote, re-open).
 *  Nothing inside single quotes is special to the shell, so quotes, `$`, backticks,
 *  `;`, newlines, and leading `-` are all inert. */
export function shQuote(arg) {
    if (arg === "")
        return "''";
    return `'${arg.replace(/'/g, "'\\''")}'`;
}
/** Join an argv into a single shell-safe command string. Each token is
 *  independently single-quoted, so no element can inject additional tokens. */
export function argvToShell(argv) {
    return argv.map(shQuote).join(" ");
}
/** Build an in-guest `env K=V … <argv>` prefix as a shell-safe argv-string.
 *  Both keys' values and the command tokens are single-quoted. Used by
 *  containment layers whose exec transport has no dedicated env flag (design
 *  §3: openshell 0.0.53 exec has no --env). */
export function envPrefixedShell(env, argv) {
    const parts = ["env"];
    for (const key of Object.keys(env ?? {}).sort()) {
        // The key itself must be a valid identifier; the value is fully quoted.
        parts.push(`${key}=${shQuote(env[key])}`);
    }
    for (const a of argv)
        parts.push(shQuote(a));
    // "env" with no assignments is a harmless no-op prefix; drop it when unused.
    return env && Object.keys(env).length > 0
        ? parts.join(" ")
        : argv.map(shQuote).join(" ");
}
//# sourceMappingURL=argv.js.map