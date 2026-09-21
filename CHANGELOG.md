# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Bearer-token authentication** on `/api/*`, `/mcp` and the `/ws/exec` upgrade (`?token=`).
  The token comes from `K8SIGHT_TOKEN`, else `~/.config/k8sight/token` (auto-generated, `0600`).
  Only `GET /healthz` and `GET /api/version` are public. The server prints the login URL
  (`http://127.0.0.1:3001/#token=…`) at boot and the UI stores the token in `sessionStorage`.
- **Host allowlist** (`localhost`, `127.0.0.1`, `[::1]`, plus `ALLOWED_HOSTS`) — any other `Host`
  gets HTTP 421, defeating DNS rebinding. Case-variant paths such as `/API/...` are 404.
- **Strict input validation** (`lib/validate.mjs`) on every namespace / kind / name / container /
  port / context parameter before it reaches `kubectl` or the Kubernetes API; flag-shaped values
  (`--all`, `--server=…`) are rejected. Kubeconfig loading is restricted to the home directory.
- **Hardened HTTP responses**: CSP on the UI document, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, no `X-Powered-By`, JSON body limit, JSON-only error
  responses, per-IP rate limiting.
- **MCP write gate** now also applies inside demo mode.
- **Electron**: fresh random token per launch; backend started on a verified-free port (never adopts
  a pre-existing listener); allow-listed environment passed to the backend (no more
  `...process.env`); renderer sandboxed (`sandbox: true`, `contextIsolation`, no `nodeIntegration`);
  `will-navigate` / `will-redirect` pinned to the backend origin; all permission requests denied;
  DevTools only in unpackaged builds; login-shell PATH probe uses `-lc` (no interactive rc files) and
  `path.delimiter`, skipped on Windows; readiness polls `/healthz`. Packaged builds carry Electron
  fuses (`RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`,
  `EnableNodeCliInspectArguments=false`, `EnableCookieEncryption=true`); the loading page has a CSP.
  Entitlements are wired up so notarization is a config flip.
- **Docker**: base image pinned by digest; `kubectl`, `kubelogin` and `trivy` installed from pinned
  releases with checksum verification (no `curl | sh`); `npm ci --omit=dev --ignore-scripts`;
  `HEALTHCHECK` on `/healthz`; `.dockerignore`; all runtime modules (`lib/`, `demo.js`, `VERSION`)
  copied so the image actually boots.
- **Supply chain / CI**: every GitHub Action pinned to a commit SHA; Dependabot for actions, npm
  (root + client) and Docker; CI runs lint, tests with coverage, build, `npm audit`, CodeQL, a Docker
  build + smoke test and a Trivy image scan on Linux/macOS/Windows. The release workflow verifies the
  tag equals `v$(cat VERSION)`, restricts manual runs to `main`, uses per-job least-privilege
  permissions, publishes `SHA256SUMS.txt`, a CycloneDX SBOM and SLSA build-provenance attestations,
  and pushes a multi-arch image to `ghcr.io/praveenraghav01/k8sight`.
- `scripts/fetch-trivy.mjs` pins the Trivy version, verifies SHA-256 against the release checksums,
  records `bin/trivy.version` and never reuses a binary of unknown version. `run.sh` no longer uses
  `sudo` or `curl | sh`, verifies the pinned kubectl checksum, and only strips the macOS quarantine
  flag from `node_modules/**/*.node`.
- Website: remote Buy-Me-a-Coffee widget removed (plain link instead); CSP and `Referrer-Policy`
  meta tags on every page; privacy policy states only what the app actually does.

### Changed

- Config directory is now `~/.config/k8sight` (was `~/.config/k8s-manager`).
- Docker image renamed to `ghcr.io/praveenraghav01/k8sight`; `npm start` / Docker now need the token.
- Node.js 22+ is required to build/run from source (`engines`, `.nvmrc`, `.npmrc`).
- `helm` is not required (releases are read from the Kubernetes API); docs updated accordingly.
- macOS builds target Apple Silicon only.
- New scripts: `npm run lint`, `npm run format`, `npm run test:client`.

### Added

- `test/validate.test.mjs`, `test/auth.test.mjs`, `test/server.http.test.mjs`,
  `test/mcp-gate.test.mjs`, `test/redact.test.mjs`; the PTY test now restores file modes and fails
  on a hung PTY.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, issue and pull-request templates.

## [1.5.1] - 2026-09-12

### Added

- Demo mode: explore every feature against a synthetic cluster with no kubeconfig.

### Changed

- Simpler connect screen and packaging polish.

## [1.5.0] - 2026-09-10

### Added

- Security Center: image CVE scan (Trivy Operator or bundled Trivy), configuration and RBAC audit,
  exposed-secret detection.

## [1.4.4] - 2026-09-10

### Added

- CLI-free Azure AKS onboarding.

### Changed

- Hardening of the local API surface.

## [1.4.3] - 2026-09-09

### Added

- MCP server (HTTP + stdio bridge).

## [1.4.2] - 2026-09-08

### Added

- One-click download links per OS.

## [1.4.1] - 2026-09-08

### Changed

- Rebranded to k8sight; cross-platform desktop builds.

## [1.3.0] - 2026-08-25

### Added

- Argo CD integration and a refreshed look.

## [1.2.0] - 2026-07-30

### Added

- AI assistant (bring your own OpenAI-compatible endpoint). 1.2.1 was a packaging patch.

## [1.1.0] - 2026-07-24

### Changed

- Polish and reliability fixes.

## [1.0.0] - 2026-07-24

- First public release.

[Unreleased]: https://github.com/praveenraghav01/k8sight/compare/v1.5.1...HEAD
[1.5.1]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.5.1
[1.5.0]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.5.0
[1.4.4]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.4.4
[1.4.3]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.4.3
[1.4.2]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.4.2
[1.4.1]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.4.1
[1.3.0]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.3.0
[1.2.0]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.2.0
[1.1.0]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.1.0
[1.0.0]: https://github.com/praveenraghav01/k8sight/releases/tag/v1.0.0
