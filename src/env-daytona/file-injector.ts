// File-based credential injector for sandboxed environments (design §6).
//
// Delivers a short-lived scoped token to the sandbox as a file, registered
// for redaction, and removed on cleanup. Generalizes loomcli's Part C/D
// credential contract.

import type { Context } from "../async/index.ts";
import type {
  Capability,
  CredentialInjector,
  Workspace,
} from "../env/types.ts";

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
export function fileCredentialInjector(
  config: FileCredentialInjectorConfig,
): CredentialInjector {
  return new FileInjector(config);
}

class FileInjector implements CredentialInjector {
  constructor(private config: FileCredentialInjectorConfig) {}

  requires(): Capability[] {
    return [];
  }

  redactions(): string[] {
    return [this.config.token];
  }

  async apply(ctx: Context, ws: Workspace): Promise<void> {
    const guestPath = this.config.guestPath;
    const hostTemp = `/tmp/daytona-token-${Date.now()}`;

    // Write the token to a temporary host file
    const fs = await import("node:fs/promises");
    await fs.writeFile(hostTemp, this.config.token, "utf8");

    try {
      // Upload to guest
      await ws.upload(ctx, hostTemp, guestPath);
    } finally {
      // Clean up the temporary host file
      await fs.unlink(hostTemp).catch(() => {});
    }
  }

  async cleanup(ctx: Context, ws: Workspace): Promise<void> {
    // Idempotently remove the credential file from the guest.
    // Use rm -f to suppress errors if the file doesn't exist.
    try {
      const guestPath = this.config.guestPath;
      await ws.exec(ctx, ["rm", "-f", guestPath]);
    } catch {
      // Idempotent: cleanup swallows errors
    }
  }
}
