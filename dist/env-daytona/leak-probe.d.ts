export declare const CREDENTIAL_SENSITIVE_ENV_NAMES: string[];
/**
 * Generate a shell command that probes for credential leaks in the current
 * environment by counting how many of the CREDENTIAL_SENSITIVE_ENV_NAMES are
 * set. The output is a single decimal number.
 *
 * Designed to run inside a sandbox via exec(). If the count is nonzero,
 * a secret reached the sandbox and the run should fail.
 *
 * Uses the same pattern as loomcli's sandboxLeakProbeCommand to ensure
 * consistency across runtimes.
 */
export declare function credentialLeakProbe(): string;
//# sourceMappingURL=leak-probe.d.ts.map