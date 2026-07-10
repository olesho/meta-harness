import type { CredentialInjector } from "../env/types.ts";
export interface FileCredentialInjectorConfig {
    /** The secret token to write. Registered for redaction before apply. */
    token: string;
    /** Guest filesystem path where the token is written (e.g., ~/.tokens/daytona). */
    guestPath: string;
}
/**
 * Creates a credential injector that writes a file-based token into the sandbox.
 *
 * The file is written to the composed workspace (inside any containment
 * boundary), registered for redaction before apply begins, and removed
 * idempotently on cleanup (even on failure paths).
 */
export declare function fileCredentialInjector(config: FileCredentialInjectorConfig): CredentialInjector;
//# sourceMappingURL=file-injector.d.ts.map