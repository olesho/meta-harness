// node-pty ships prebuilt `spawn-helper` binaries whose execute bit is lost
// during npm's tarball extraction (node-pty 1.1.0). Without +x, pty.fork() dies
// with "posix_spawnp failed" and every PTY-backed test fails. Restore the bit
// here after install. Cross-platform: silently no-ops where the file is absent
// (e.g. Windows, which uses conpty.node and has no spawn-helper).
import { chmodSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prebuilds = join(root, "node_modules", "node-pty", "prebuilds");

for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
  const helper = join(prebuilds, platform, "spawn-helper");
  if (!existsSync(helper)) continue;
  const mode = statSync(helper).mode;
  // add u+x g+x o+x (0o111) without disturbing existing bits
  chmodSync(helper, mode | 0o111);
}
