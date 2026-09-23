# Contributing to k8dashboard

Thanks for helping. This page covers the local setup, the checks CI runs, and how releases work.

## Prerequisites

- **Node.js 22+** (`.nvmrc` pins 22; `.npmrc` sets `engine-strict`).
- `kubectl` on your `PATH` for real clusters (demo mode needs nothing).
- macOS/Linux/Windows all work for development. The packaged macOS build targets Apple Silicon only.

## Setup

```bash
npm ci --ignore-scripts          # no lifecycle scripts from third-party packages
npm rebuild node-pty             # the one native addon we need (Linux has no prebuild)
node scripts/fix-pty-helper.mjs  # restores node-pty's spawn-helper exec bit (macOS)
npm ci --prefix client --ignore-scripts
npm run dev                      # UI on :3000, API on :3001
```

The backend prints `open http://127.0.0.1:3001/#token=…`. Use that `#token=` fragment on the
Vite URL too, or set `K8DASHBOARD_TOKEN=dev-token-…` in your shell so it is stable across restarts.

`./run.sh dev` does the same from one command (never with `sudo` and never via `curl | sh`).

## Checks (what CI runs)

```bash
npm run lint      # eslint (flat config; react-hooks/exhaustive-deps is an error)
npm run format    # prettier --check (run `npm run format:write` to fix)
npm test          # node --test with coverage — unit + HTTP integration tests
npm run build     # client production build
```

The HTTP tests start `server.js` as a child process on a free port with a fixed token and
`KUBECONFIG=/nonexistent`, then exercise auth, host/origin guards, validation, headers and the
WebSocket upgrade. Add a `test/*.test.mjs` for every behaviour you change; keep tests hermetic
(temporary `HOME`, no network).

CI also runs `npm audit --audit-level=high`, CodeQL, a Docker build + `/healthz` smoke test and a
Trivy scan of the image (fails on CRITICAL).

## Project layout

| Path | What |
|------|------|
| `server.js`, `lib/` | Express backend: auth (`lib/auth.mjs`), validation (`lib/validate.mjs`), caching, kubectl runner, logger |
| `client/` | React + Vite UI |
| `electron/` | Desktop shell (`main.cjs`), packaging hook (`after-pack.cjs`), loading page |
| `assistant.js`, `mcp.js`, `mcp-stdio.js` | AI assistant and MCP server / stdio bridge |
| `aws-eks.js`, `azure-aks.js`, `*-token.js` | Cloud discovery and token helpers |
| `trivy-scan.js` | Security Center scanning |
| `scripts/` | `sync-version.mjs`, `fetch-trivy.mjs` (pinned + checksum-verified), `fix-pty-helper.mjs` |
| `Dockerfile` | Multi-stage image; tool versions are `ARG`s at the top |
| `.github/workflows/` | `ci.yml`, `release.yml` (actions pinned to commit SHAs; Dependabot bumps them) |

## Pull requests

- Keep PRs focused; describe the *why*. Fill in the PR template checklist.
- Security-relevant changes (auth, validation, Electron, Docker, workflows) should explain the
  threat they address and add a test.
- Update `CHANGELOG.md` under **Unreleased**, and docs (`README.md`, `website/docs.html`) when
  behaviour or configuration changes.
- Never commit kubeconfigs, tokens or `.env` files. `.gitignore` covers the usual suspects.
- Do not bump dependency pins by hand unless needed for the change; Dependabot handles routine bumps.

## Coding conventions

- ESM everywhere except `electron/*.cjs`. Prettier: single quotes, 110 columns, semicolons.
- Validate every external input with `lib/validate.mjs` before it reaches `kubectl` or the API.
- Return errors as JSON `{ error, code }`; never HTML.
- Log with `lib/logger.mjs`; never log tokens, kubeconfig contents or Secret data.

## Releases

1. `node scripts/sync-version.mjs 1.2.0` — updates `VERSION`, both `package.json`s, the lockfiles
   and the Dockerfile `ARG APP_VERSION`. Move the **Unreleased** section of `CHANGELOG.md` to the
   new version.
2. Commit, then `git tag v1.2.0 && git push origin main v1.2.0`.
3. The **Build & Release** workflow verifies the tag equals `v$(cat VERSION)` (it fails otherwise),
   builds all installers, pauses for approval on the `release` environment, then publishes the
   GitHub Release on [jaychandra1/KubePilot](https://github.com/jaychandra1/KubePilot)
   (installers, `SHA256SUMS.txt`, CycloneDX SBOM) and pushes
   `ghcr.io/jaychandra1/k8dashboard:{v1.2.0,1.2,latest}` for amd64 + arm64.
   Optional: add a `RELEASE_TOKEN` secret (fine-grained PAT on KubePilot with
   Contents: write) to publish there. Without it the GitHub Release is created on this repo.

Manual runs (Actions → Build & Release → Run workflow) are only accepted from `main`.

### Bumping pinned tools

- `kubectl`, `kubelogin`, `trivy`: `ARG`s at the top of the `Dockerfile`; keep `TRIVY_VERSION` equal to
  the constant in `scripts/fetch-trivy.mjs` and `KUBECTL_VERSION` equal to the one in `run.sh`.
- Base image digest: Dependabot's `docker` ecosystem opens PRs; or resolve one with
  `docker manifest inspect node:22-alpine`.

### Code signing (macOS)

The app is ad-hoc signed today. To ship a notarized build: set `build.mac.identity` and
`hardenedRuntime: true` in `package.json` (entitlements are already wired to
`build/entitlements.mac.plist`), add the certificate/notary secrets to the release workflow, and remove
the ad-hoc signing step in `electron/after-pack.cjs` (the fuses step stays).
