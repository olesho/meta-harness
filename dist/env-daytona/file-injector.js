// File-based credential injector for sandboxed environments (design §6).
//
// Delivers a short-lived scoped token to the sandbox as a file, registered
// for redaction, and removed on cleanup. Generalizes loomcli's Part C/D
// credential contract.
/**
 * Creates a credential injector that writes a file-based token into the sandbox.
 *
 * The file is written to the composed workspace (inside any containment
 * boundary), registered for redaction before apply begins, and removed
 * idempotently on cleanup (even on failure paths).
 */
export function fileCredentialInjector(config) {
    return new FileInjector(config);
}
class FileInjector {
    config;
    constructor(config) {
        this.config = config;
    }
    requires() {
        return [];
    }
    redactions() {
        return [this.config.token];
    }
    async apply(ctx, ws) {
        const guestPath = this.config.guestPath;
        const hostTemp = `/tmp/daytona-token-${Date.now()}`;
        // Write the token to a temporary host file
        const fs = await import("node:fs/promises");
        await fs.writeFile(hostTemp, this.config.token, "utf8");
        try {
            // Upload to guest
            await ws.upload(ctx, hostTemp, guestPath);
        }
        finally {
            // Clean up the temporary host file
            await fs.unlink(hostTemp).catch(() => { });
        }
    }
    async cleanup(ctx, ws) {
        // Idempotently remove the credential file from the guest.
        // Use rm -f to suppress errors if the file doesn't exist.
        try {
            const guestPath = this.config.guestPath;
            await ws.exec(ctx, ["rm", "-f", guestPath]);
        }
        catch {
            // Idempotent: cleanup swallows errors
        }
    }
}
//# sourceMappingURL=file-injector.js.map