export declare const CREDENTIAL_SENSITIVE_ENV_NAMES: string[];
/**
 * Generate a shell command that probes for credential leaks in the current
 * environment by counting how many of the CREDENTIAL_SENSITIVE_ENV_NAMES are
 * set. The output is a single decimal number.
 *
 * Designed to run inside a sandbox via exec(). If the count is nonzero,
 * a secret reached the sandbox and the run should fail.
 *
 * Each name is emitted SPLIT on "_" — `['DAYTONA','API','KEY']`, rejoined by the
 * guest at runtime — so the probe's own source text carries no literal secret
 * name for a scanner (or a curious guest process listing) to pick up. Same shape
 * as loomcli's sandboxLeakProbeCommand, so the two stay diffable.
 */
export declare function credentialLeakProbe(): string;
//# sourceMappingURL=leak-probe.d.ts.map