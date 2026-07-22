/** Normalize a harness name for switch matching ("claude-code" → matches "claude"). */
export declare function normHarness(h: string): string;
export declare function prependArgs(args: string[], ...prefix: string[]): string[];
export declare function argsContainFlag(args: string[], flag: string): boolean;
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
export declare function argsContainAnyFlag(args: string[], flags: readonly string[]): boolean;
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
export declare function flagValue(args: string[], ...names: string[]): [string, boolean];
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
export declare function configKeyValue(args: string[], key: string): [string, boolean];
export declare function argsContainConfigKey(args: string[], key: string): boolean;
//# sourceMappingURL=harnessargs.d.ts.map