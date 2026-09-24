# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed

- The built-in demo cluster is no longer shown; the synthetic fixture remains available to tests via `KUBEPILOT_DEMO=1`. The connect screen now offers exactly two paths: load a kubeconfig, or **Add cluster** (AWS EKS / Azure AKS).

### Fixed

- Imported EKS/AKS clusters could not connect from the packaged desktop app ("Unexpected end of JSON input"): the kubeconfig exec entry relied on `ELECTRON_RUN_AS_NODE`, which the app's fuses disable. Entries now run `KubePilot --token-helper eks|azure …` (or `node eks-token.js …` from source), stale entries are repaired automatically when the kubeconfig loads, and an expired AWS SSO session shows a "Sign in with AWS SSO" prompt instead of a raw error.

### Changed

- Trivy is downloaded on first use instead of being bundled, shrinking the installer by ~50 MB; `npm run dist:bundled-trivy` restores bundling.
- Renamed to KubePilot; legacy `K8DASHBOARD_*`/`K8SIGHT_*` env vars, `~/.config/k8dashboard` and the old MCP source header remain accepted.
  Installers are now `KubePilot-macos.dmg`, `KubePilot-windows.exe`, `KubePilot-linux.AppImage` / `.deb`, published on
  [jaychandra1/KubePilot](https://github.com/jaychandra1/KubePilot/releases); the container image is `ghcr.io/jaychandra1/kubepilot`.

## [1.2.0] - 2026-09-23

First public release of **k8dashboard**.

### Added

- Native desktop app for macOS (Apple Silicon), Windows and Linux, plus a Docker image.
- Live cluster dashboard, resource browsing and editing, topology, logs, an in-pod terminal, Helm, Argo CD, and one-click EKS / AKS / GKE onboarding.
- Security Center: image CVE scan (Trivy Operator or bundled Trivy), configuration and RBAC audit, exposed-secret detection.
- Demo mode: explore every feature against a synthetic cluster with no kubeconfig.
- MCP server (HTTP + stdio bridge) so agents can operate the connected cluster.
- Optional AI assistant (bring your own OpenAI-compatible endpoint).

### Security

- **Bearer-token authentication** on `/api/*`, `/mcp` and the `/ws/exec` upgrade (`?token=`).
  The token comes from `K8DASHBOARD_TOKEN`, else `~/.config/k8dashboard/token` (auto-generated, `0600`).
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
- **Electron**: fresh random token per launch; backend started on a verified-free port; allow-listed
  environment; sandboxed renderer; DevTools only in unpackaged builds. Packaged builds carry
  Electron fuses.
- **Docker**: base image pinned by digest; `kubectl`, `kubelogin` and `trivy` installed from pinned
  releases with checksum verification; `HEALTHCHECK` on `/healthz`.

[Unreleased]: https://github.com/jaychandra1/k8dashboard/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/jaychandra1/KubePilot/releases/tag/v1.2.0
