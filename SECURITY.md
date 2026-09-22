# Security Policy

k8dashboard runs with the full privileges of your kubeconfig. We treat anything that lets an
unauthorised party reach the API, the MCP endpoint, the exec WebSocket, or the Electron main
process as a security issue.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: open a private report via
  [GitHub Security Advisories](https://github.com/jaychandra1/k8dashboard/security/advisories/new).
- Or email **security@k8dashboard.in** (placeholder — replace with the maintainer's monitored address).

Include the version (`GET /api/version` or Preferences → About), how you are running it
(desktop app / Docker / source), reproduction steps and, if you have one, a suggested fix.
You will get an acknowledgement within **5 working days** and a fix or mitigation plan within
**30 days** for confirmed issues. We are happy to credit reporters in the release notes.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest `1.x` release | ✅ security fixes |
| older `1.x` | ❌ upgrade to the latest release |

Only the most recent release receives fixes. Releases are published for macOS (Apple Silicon),
Windows, Linux and as `ghcr.io/jaychandra1/k8dashboard`.

## Scope

In scope:

- Authentication / authorisation bypass of the bearer token on `/api/*`, `/mcp` or `/ws/exec`.
- DNS rebinding, CSRF or cross-origin access to the backend.
- Command or argument injection into `kubectl` / cloud CLIs, path traversal, SSRF.
- Secrets leaking to logs, the AI assistant endpoint, or the renderer beyond what the UI shows.
- Electron issues: sandbox escape, navigation to foreign origins, Node access from the renderer,
  insecure IPC, environment leakage to the backend process.
- Supply-chain issues in the build, the Docker image or the release workflow.

Out of scope:

- Anything requiring an already-compromised machine or a malicious kubeconfig you chose to load.
- Vulnerabilities in the clusters you connect to, or in third-party tools (`kubectl`, `trivy`)
  unless k8dashboard invokes them unsafely.
- The marketing website (static HTML) beyond content injection.

## Hardening summary (what the app does)

- Bearer token (`K8DASHBOARD_TOKEN` or `~/.config/k8dashboard/token`, mode 0600) on every non-public route.
- Loopback bind by default; `Host` allowlist (HTTP 421 otherwise); strict same-origin checks.
- CSP, `X-Frame-Options: DENY`, `nosniff`, rate limiting, body-size limits, strict input validation.
- Electron: sandboxed renderer, `contextIsolation`, no `nodeIntegration`, navigation pinned to the
  backend origin, all permission requests denied, fuses disabling `RunAsNode` / `NODE_OPTIONS` /
  `--inspect`, allow-listed environment for the backend process, fresh token per launch.
- Docker: pinned base-image digest, checksum-verified `kubectl` / `kubelogin` / `trivy`, non-root user,
  `npm ci --ignore-scripts`, image scanned with Trivy in CI.
- Releases: SHA256SUMS, CycloneDX SBOM and SLSA build-provenance attestations for every artifact.
