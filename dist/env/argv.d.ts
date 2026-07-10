/** Single-quote one argument for POSIX `sh`.
 *
 *  Empty string → `''`. Otherwise wrap in single quotes and escape any embedded
 *  single quote via the `'\''` idiom (close-quote, escaped-quote, re-open).
 *  Nothing inside single quotes is special to the shell, so quotes, `$`, backticks,
 *  `;`, newlines, and leading `-` are all inert. */
export declare function shQuote(arg: string): string;
/** Join an argv into a single shell-safe command string. Each token is
 *  independently single-quoted, so no element can inject additional tokens. */
export declare function argvToShell(argv: readonly string[]): string;
/** Build an in-guest `env K=V … <argv>` prefix as a shell-safe argv-string.
 *  Both keys' values and the command tokens are single-quoted. Used by
 *  containment layers whose exec transport has no dedicated env flag (design
 *  §3: openshell 0.0.53 exec has no --env). */
export declare function envPrefixedShell(env: Record<string, string> | undefined, argv: readonly string[]): string;
//# sourceMappingURL=argv.d.ts.map