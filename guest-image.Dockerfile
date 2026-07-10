# Guest image reference for meta-harness sandboxed turns.
#
# This Dockerfile documents the required layout and contract for any guest image
# that runs meta-harness-structured-run. It is a reference, not a production build;
# actual deployments (loomcli, orche) maintain their own images and may diverge
# in base OS, optional tools, etc. This layer is a contract specification.
#
# §8 guest image contract (docs/design/pluggable-environments.md:271):
# - dist tree at /opt/meta-harness/dist (pinned to a commit)
# - meta-harness-structured-run on PATH
# - node-pty + ptyHost.mjs (guest-arch only)
# - META_HARNESS_PTY_HOST env pointing to ptyHost.mjs
# - node interpreter on PATH
# - Harness binaries on PATH or via HARNESS_BINARY_*
# - Docker LABEL convention for binary paths (for OpenShell policy)
# - PTY smoke-check at build time

FROM node:20-alpine

# Required Node.js version check
RUN node --version

# 1. Install dist tree
COPY dist /opt/meta-harness/dist

# 2. Create a symlink on PATH for meta-harness-structured-run
RUN ln -s /opt/meta-harness/dist/cli/structured-runner.js /usr/local/bin/meta-harness-structured-run && \
    chmod +x /opt/meta-harness/dist/cli/structured-runner.js

# 3. Copy and set up node-pty + ptyHost.mjs
# The addon MUST be guest-arch (built in-image or as a prebuilt guest tarball).
# For this reference, assume it's co-located in dist/wrapper/internal/
COPY dist/wrapper/internal/ptyHost.mjs /opt/meta-harness/dist/wrapper/internal/
RUN chmod +x /opt/meta-harness/dist/wrapper/internal/ptyHost.mjs

# 4. Set META_HARNESS_PTY_HOST (source of truth: src/wrapper/internal/pty.ts:44)
ENV META_HARNESS_PTY_HOST=/opt/meta-harness/dist/wrapper/internal/ptyHost.mjs

# 5. Harness binaries (if needed in-guest; some may be host-injected)
# Placeholder: actual harnesses (claude, codex) would be installed here or set via HARNESS_BINARY_*

# 6. Docker LABEL convention for binary paths (orche image/Dockerfile:56-60)
# These are consumed by OpenShell policy generation for per-binary egress rules
LABEL meta-harness.binary.claude="/usr/local/bin/claude"
LABEL meta-harness.binary.codex="/usr/local/bin/codex"

# 7. PTY smoke-check: run the ptyHost self-test at build time
# This ensures the addon is functional before the image is used.
# The test spawns a small process and verifies PTY data round-trips correctly.
RUN node /opt/meta-harness/dist/wrapper/internal/ptyHost.mjs <<'PTYEOF'
{
  "binaryPath": "node",
  "args": ["-e", "console.log('pty ok')"],
  "cols": 80,
  "rows": 24
}
PTYEOF

# 8. Working directories per §3 Workspace contract
RUN mkdir -p /repo /home /tmp && \
    chmod 1777 /tmp && \
    chmod 755 /repo /home

WORKDIR /repo
