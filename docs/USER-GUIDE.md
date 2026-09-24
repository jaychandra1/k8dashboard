# KubePilot — User & Release Guide

This guide covers three things: **running and using the application**, **developing it locally**, and **producing a new release version** (desktop installers and the Docker image).

Current version: `1.2.0` (see the `VERSION` file). Node.js **22 or newer** is required to build or run from source.

---

## Part 1 — Running the application

### 1.1 What you need

| To do this | You need |
|---|---|
| Browse a real cluster | A working kubeconfig (`~/.kube/config` or `KUBECONFIG`) and `kubectl` on your `PATH` (used for exec, port-forward and a few reads). |
| Import an EKS or AKS cluster | An AWS or Azure account with access to the cluster — **Add cluster** signs you in and writes the kubeconfig; no `aws`/`az` CLI needed. |
| Pod shell / port-forward | `kubectl` on `PATH`. |
| Security Center image scans | Nothing extra: the Docker image includes Trivy; the desktop app and source builds download it on first use (pinned version, checksum-verified) into `~/.config/kubepilot/bin`. |
| AI assistant | Any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM, LiteLLM…). |

### 1.2 Three ways to run it

**A. Desktop app (recommended for laptops)**

Download the installer for your OS from the [KubePilot Releases](https://github.com/jaychandra1/KubePilot/releases) page (`KubePilot-macos.dmg` for Apple Silicon, `KubePilot-windows.exe`, `KubePilot-linux.AppImage` or `.deb`) and open it.

The desktop app generates a fresh random access token every launch, starts its backend on a free local port, and opens the UI already logged in. There is nothing to configure.

Builds are ad-hoc signed, so on first launch: macOS → right-click → **Open**; Windows SmartScreen → **More info → Run anyway**.

**B. From source (single port)**

```bash
npm ci --ignore-scripts
npm rebuild node-pty
npm ci --prefix client
npm run build
npm start
```

The server prints a **login URL** at boot:

```
KubePilot listening on http://127.0.0.1:3001  —  open http://127.0.0.1:3001/#token=<token>
```

Open that exact URL. The UI moves the token from the URL into session storage and removes it from the address bar. If you open `http://127.0.0.1:3001` without the token, the UI shows a **Connect** dialog where you can paste it.

The token is generated once and saved to `~/.config/kubepilot/token` (mode `0600`), so it stays the same across restarts unless you set `KUBEPILOT_TOKEN` yourself.

**C. Docker**

```bash
docker run --rm -p 127.0.0.1:8080:3001 \
  -v "$HOME/.kube:/home/node/.kube:ro" \
  ghcr.io/jaychandra1/kubepilot:latest
```

Get the token from the container log:

```bash
docker logs <container> 2>&1 | grep token=
```

Then open `http://localhost:8080/#token=<token>`. To use a fixed token instead, pass `-e KUBEPILOT_TOKEN=<at least 16 characters>`.

Keep the port published on `127.0.0.1`. If you must expose it on a network, put an authenticating reverse proxy in front and add the proxy's hostname to `ALLOWED_HOSTS` and its origin to `ALLOWED_ORIGINS` (see §1.9), otherwise requests through another hostname are refused with HTTP 421.

### 1.3 First run: pick a cluster

When the app starts it shows one of:

- **Connect a cluster** — no kubeconfig was found. Either enter the path to a kubeconfig file, or use **Add cluster** to import an **AWS EKS** or **Azure AKS** cluster straight from your cloud account (KubePilot signs you in and writes the kubeconfig; no CLI needed).
- **Could not connect to the cluster** — a kubeconfig was loaded but its credentials failed. Use **Add cluster** to onboard an EKS or AKS cluster, switch to another context, or fix the kubeconfig and press **Retry**. Authentication failures are classified for you (expired token, unreachable API server, TLS error, missing auth plugin) with a one-click or copyable fix.
- The dashboard — the current kubeconfig context loaded.

Switch clusters any time from the **Context** selector in the sidebar (searchable) or with `⌘K` / `Ctrl+K` → type the context name. Pin favourites to the left rail with the **+** button.

### 1.4 Getting around

- **Sidebar** — Cluster, Nodes, Namespaces, Topology; Workloads (Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs…); Config; Network; Storage; Events, Helm, Access Control, Argo CD (shown when installed), Security Center, Custom Resources. Every item is a real link, so keyboard navigation, middle-click and "open in new tab" work.
- **Command palette** — `⌘K` (`Ctrl+K` on Windows/Linux) jumps to any view, switches context, refreshes, opens Preferences or changes the theme. Type to filter, arrows to move, Enter to run.
- **Back / Forward** — the toolbar arrows and your browser's back/forward both work, because every view has a URL:

  | URL | Opens |
  |---|---|
  | `#/overview` | Cluster overview |
  | `#/pod?ns=default,shop` | Pods filtered to two namespaces |
  | `#/pod/default/my-pod-abc` | Pods list with the detail drawer open on that pod |
  | `#/deployment?q=api` | Deployments with the search box pre-filled |
  | `#/nodes/node-1` | Node detail |
  | `#/persistentVolume/pv-data` | Cluster-scoped resource (no namespace segment) |
  | `#/argocd/applications`, `#/security/vulnerabilities`, `#/preferences/mcp` | Sub-views |

  Refreshing the page keeps you where you were. You can bookmark or share these links.

- **Namespace filter** — the "All namespaces" control at the top of resource views is a multi-select; the choice is kept in the URL (`?ns=`).
- **Search** — press `/` to focus the search box of the current view.
- **Auto-refresh** — the toolbar shows the interval (1 min by default). Click it to change or to refresh now. Refreshing never wipes your selection, scroll position or open panels.
- **Theme** — Preferences → General, or the palette (Theme: Dark / Light / System). The chosen theme is applied before the first paint, so there is no flash.

### 1.5 Working with resources

Every resource view is a sortable table (click a header or press Enter on it). Rows are keyboard-operable:

| Key | Action |
|---|---|
| `↑` `↓` `Home` `End` | Move between rows |
| `Enter` / `Space` | Open the detail drawer |
| `Shift+F10` or the Context-Menu key | Open the row's action menu |
| `Esc` | Close the drawer / menu / dialog |

Each row also has an always-visible **Actions** button (`⋯`). Actions available per kind:

- **Details** — drawer with status, labels, annotations, containers, owner and cross-links (namespace → node → pod → owner are all links). Pods show live CPU/memory charts. ConfigMap data is shown; **Secret values are masked until you click Reveal** on a specific key, and can be copied.
- **Logs** — per-container or merged streams, timestamps, regex/case-sensitive search with match navigation, tail size (200 / 1,000 / 5,000 / 20,000 lines), follow mode, download.
- **Terminal** — a real TTY into the container (`kubectl exec -it`). The container needs a shell (distroless images will not work).
- **Edit YAML** — edit and apply. `⌘S` / `Ctrl+S` applies; you are asked to confirm because this writes to the cluster, and closing with unsaved changes asks first.
- **Scale** — integer 0–10,000.
- **Rollout restart**.
- **Delete** — two-step confirmation; bulk deletes require typing `delete`.
- **Port-forward** (Services) — forward a service port to `localhost` (ports 1–65,535; privileged ports warn). Active forwards are listed with a Stop button.

Select several rows with the checkboxes to run **bulk Restart / Delete** from the bar that appears (both require confirmation).

### 1.6 Other views

- **Overview** — pod health donut and workload counts; every card and bar is a link into the matching list.
- **Nodes** — capacity, allocatable, conditions, pods on the node with live metrics (needs `metrics-server` in the cluster; otherwise metrics show `—`).
- **Topology** — pan/zoom graph of workloads, services, ingress, config and storage. Keyboard: focus the canvas, arrows to pan, `+`/`-` to zoom; a **List view** toggle gives the same data as a table.
- **Helm** — releases decoded from their release Secrets (the `helm` binary is not needed), with values and rendered manifest.
- **Access Control** — roles, bindings and service accounts.
- **Custom Resources** — a lazy-loaded tree of CRDs → instances (arrow keys expand/collapse), with YAML detail.
- **Argo CD** (auto-detected) — dashboard, applications with sync/health filters, resource tree, history, projects, application sets, repositories, clusters. Sync, Refresh and Delete ask for confirmation; cascade delete requires typing the app name.
- **Security Center** — image CVEs, configuration and RBAC checks, exposed secrets. Reads Trivy Operator reports if present, otherwise runs Trivy (downloaded on first use, see §1.1). Start a scan from the Scan panel; progress is announced and polled while the view is visible.
- **Events** — cluster or namespace events with links to the involved objects.

### 1.7 Keyboard shortcuts

Press `?` anywhere (outside an input) to open the shortcuts sheet.

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `?` | Shortcuts sheet |
| `/` | Focus search |
| `Esc` | Close the topmost panel, menu or dialog |
| `↑ ↓ Home End`, `Enter`, `Shift+F10` | Table navigation and actions |
| `⌘S` / `Ctrl+S` | Apply in the YAML editor |

### 1.8 Preferences

Open Preferences from the sidebar gear or the palette. Sections: **General** (theme, refresh), **Kubernetes** (kubeconfig path, reload), **Cloud Integrations** (AWS / Azure sign-in), **External Tools** (which AI coding agent to launch), **AI Assistant**, **MCP Server**, **About**.

**AI Assistant (built-in).** Enter an OpenAI-compatible base URL, API key and model in Preferences → AI Assistant, or set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` before starting. The assistant is read-only: it inspects the cluster through tools and streams its answer. Secret object values and secret-looking environment values are redacted before anything leaves the app. Link-local/metadata addresses are refused as endpoints; local endpoints such as Ollama are allowed.

**AI coding agents.** The app detects Claude Code, GitHub Copilot CLI, Gemini CLI, Codex and opencode on your `PATH` and can open them in a docked terminal (or an external terminal on macOS/Linux) with a temporary kubeconfig pinned to the current context. Only detected, known agents can be launched.

**MCP Server.** The app is also an MCP server so external agents can inspect (and, if you enable it, change) the cluster. Preferences → MCP Server shows ready-to-copy snippets. Read tools are always on; **write tools are off by default** and enforced by the server, not just hidden. Toggle **Write access** there (reconnect the agent afterwards).

HTTP transport (recommended while the app runs):

```bash
claude mcp add --transport http kubepilot http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer <token>"
```

Stdio bridge (for agents that launch a command):

```json
{
  "mcpServers": {
    "kubepilot": {
      "command": "node",
      "args": ["/absolute/path/to/kubepilot/mcp-stdio.js"],
      "env": { "MCP_API_BASE": "http://127.0.0.1:3001", "MCP_API_TOKEN": "<token>" }
    }
  }
}
```

**Cloud onboarding.** Preferences → Cloud Integrations (or **Add cluster** on the connect screen):

- **AWS EKS** — sign in with IAM Identity Center (SSO), access keys or an assumed role; discover clusters across accounts and regions; import them. An SSO profile is written to `~/.aws/config` so credentials refresh automatically.
- **Azure AKS** — sign in through your system browser (works with Conditional Access) or the `az` CLI; discover across subscriptions; import.

Imported contexts are merged into your kubeconfig. The existing file is **backed up** (`config.kubepilot-backup-<timestamp>`) before the first write of a session, written atomically with mode `0600`, and never overwritten if it cannot be parsed. Imported clusters authenticate at runtime through bundled token helpers, so `aws`, `az` and `kubelogin` are not needed afterwards. The kubeconfig `exec` entry runs `KubePilot --token-helper eks|azure …` (the desktop app re-enters its own binary in a CLI mode) or `node eks-token.js …` / `node azure-token.js …` when running from source or Docker; `kubectl` works with the same entry. Entries written by an older build, or pointing at an app binary that has since moved or been renamed, are **repaired automatically** the next time the kubeconfig is loaded (a backup is taken first, one log line per repaired user). If your AWS SSO session has expired, the connect screen says so and offers **Sign in with AWS SSO**, which reopens the AWS flow.

### 1.9 Configuration reference

| Variable | Purpose | Default |
|---|---|---|
| `KUBEPILOT_TOKEN` | Bearer token for `/api/*`, `/mcp` and `/ws/exec` | generated → `~/.config/kubepilot/token` |
| `KUBECONFIG` | Kubeconfig path(s) | `~/.kube/config` |
| `KUBECONFIG_DIRS` | Extra directories from which "Load kubeconfig" may read | — |
| `PORT` | Backend port | `3001` |
| `HOST` | Bind interface | `127.0.0.1` (Docker: `0.0.0.0`) |
| `ALLOWED_HOSTS` | Extra `Host` values accepted (e.g. `kubepilot.internal:8080`) | — |
| `ALLOWED_ORIGINS` | Extra browser origins allowed to call the API | — |
| `TRUST_PROXY` | Set `1` behind a reverse proxy so rate limiting sees client IPs | — |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Assistant endpoint | — |
| `MCP_ALLOW_WRITE` | Initial default for MCP write tools | `0` |
| `MCP_API_BASE`, `MCP_API_TOKEN` | Used by the stdio bridge | `http://127.0.0.1:3001`, token file |
| `LOG_LEVEL` | `debug` `info` `warn` `error` | `info` |
| `TRIVY_VERSION` | Pin or `latest` for on-demand Trivy download | `0.74.0` |

App data lives in `~/.config/kubepilot` (token, assistant config, scan cache). Logs are JSON lines on stdout; the request log never contains query strings, headers or tokens.

### 1.10 Troubleshooting

| Symptom | Fix |
|---|---|
| "Unauthorized" / Connect dialog | Open the full login URL printed at boot, or paste the token. |
| HTTP 421 Misdirected request | You used a hostname the server does not know. Add it to `ALLOWED_HOSTS`. |
| "No kubeconfig loaded" | Create `~/.kube/config` or set `KUBECONFIG`. |
| Metrics show `—` | Install `metrics-server` in the cluster. |
| Terminal will not open | The container has no shell, or `kubectl` is not on `PATH`. |
| Helm view empty | The cluster has no Helm-managed releases (v3 Secrets storage). |
| "All namespaces" slow the first time | One request per namespace; results are cached. Pick a namespace for faster loads. |
| Port 3001 in use | Set `PORT=<other>` (the desktop app picks a free port automatically). |

---

## Part 2 — Developing

### 2.1 Setup

```bash
git clone <repo> kubepilot && cd kubepilot
npm ci --ignore-scripts        # never runs third-party lifecycle scripts
npm rebuild node-pty           # the one native addon (Linux has no prebuild)
npm ci --prefix client
```

`.nvmrc` pins Node 22 and `.npmrc` enforces it.

### 2.2 Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend on :3001 plus Vite dev server on :3000 with hot reload. Open the login URL printed by the backend but on port 3000 (`http://localhost:3000/#token=…`). |
| `npm start` | Backend serving the built UI on :3001. |
| `npm test` | Backend tests (Node test runner, with coverage): auth, host allowlist, validation, HTTP contract, MCP gate, redaction, PTY. |
| `npm run test:client` | Client tests (Vitest + Testing Library): hooks, UI kit, routing, views. |
| `npm run lint` | ESLint (flat config; hook-dependency mistakes are errors). |
| `npm run format` / `format:write` | Prettier check / write. |
| `npm run build` | Syncs the version into all manifests, then builds the client into `client/dist`. |

CI runs lint, both test suites, the build, `npm audit`, CodeQL, a Docker build with a smoke test, and a Trivy scan of the image on every pull request and push to `main`, on Linux, macOS and Windows.

### 2.3 Where things live

| Path | Contents |
|---|---|
| `server.js` | Express backend: routes, WebSocket shell, MCP endpoint |
| `lib/` | `auth.mjs` (token, host allowlist, origin guard), `validate.mjs`, `kubectl.mjs` (safe argv wrapper), `cache.mjs`, `logger.mjs`, `http-errors.mjs` |
| `assistant.js`, `mcp.js`, `mcp-stdio.js` | AI assistant, MCP tools, stdio bridge |
| `aws-eks.js`, `azure-aks.js`, `eks-token.js`, `azure-token.js` | Cloud onboarding and runtime token helpers |
| `trivy-scan.js` | Security scanning (Trivy Operator reports or an on-demand Trivy download) |
| `demo.js` | Synthetic in-memory cluster used as a test fixture (only with `KUBEPILOT_DEMO=1`; never shown in the app) |
| `client/src/` | React app: `App.jsx`, `components/shell/` (routing, auth gate, fan-out), `components/ui/` (Modal, DataTable, Menu, …), `lib/` (api, format, status, kinds), `hooks/` |
| `electron/` | Desktop shell (`main.cjs`), fuses and signing (`after-pack.cjs`) |
| `test/`, `client/src/**/*.test.*` | Test suites |
| `.github/workflows/` | `ci.yml`, `release.yml` (actions pinned to commit SHAs; Dependabot bumps them) |
| `Dockerfile`, `.dockerignore` | Multi-stage image with pinned, checksum-verified `kubectl`, `kubelogin`, `trivy` |

Conventions: ESM everywhere except `electron/*.cjs`; validate every external input with `lib/validate.mjs` before it reaches `kubectl` or the API; return errors as JSON `{ error, code }`; log through `lib/logger.mjs`; never log tokens, kubeconfig contents or Secret data; update `CHANGELOG.md` under **Unreleased** with every behaviour change.

---

## Part 3 — Producing a new version

Versions follow **Semantic Versioning**: patch for fixes (`1.2.0 → 1.2.1`), minor for features (`→ 1.3.0`), major for breaking changes (`→ 2.0.0`). The single source of truth is the `VERSION` file; everything else is derived from it.

### 3.1 Release checklist

1. **Make sure `main` is green.** All CI jobs must pass on the commit you intend to release.

2. **Bump the version everywhere with one command:**

   ```bash
   node scripts/sync-version.mjs 1.2.0
   ```

   This writes `VERSION`, both `package.json` files, both lockfiles and the Dockerfile's `ARG APP_VERSION`. Running it without an argument re-propagates whatever `VERSION` contains (the `build` script does this automatically).

3. **Update `CHANGELOG.md`.** Rename the `## [Unreleased]` section to `## [1.2.0] – 2026-MM-DD` and start a fresh empty `Unreleased` above it. Keep the Keep-a-Changelog headings (Added / Changed / Fixed / Security).

4. **Commit and tag.** The tag must be exactly `v` + the contents of `VERSION`:

   ```bash
   git add -A
   git commit -m "Release 1.2.0"
   git tag v1.2.0
   git push origin main v1.2.0
   ```

5. **Watch the Build & Release workflow** (GitHub → Actions → *Build & Release*). It runs these jobs in order:

   | Job | What happens |
   |---|---|
   | **Verify tag == VERSION** | Fails immediately if the tag and `VERSION` disagree, or if a manual run was started from a branch other than `main`. |
   | **Build** (macOS arm64, Windows x64, Linux x64) | `npm ci`, tests, `npm run dist` → installers uploaded as artifacts. |
   | **Publish GitHub Release** | Waits for approval on the `release` environment, then generates `SHA256SUMS.txt` and a CycloneDX SBOM. Publishes on the public [jaychandra1/KubePilot](https://github.com/jaychandra1/KubePilot) repo using the `KUBEPILOT_RELEASE_TOKEN` secret (a fine-grained PAT with Contents: read & write on that repo); the job fails with a clear error if the secret is missing. |
   | **Publish Docker image (GHCR)** | Also gated by the `release` environment. Builds amd64 + arm64 and pushes `ghcr.io/jaychandra1/kubepilot:v1.2.0`, `:1.2` and `:latest`. |

   When the workflow pauses, a reviewer on the `release` environment approves it in the Actions UI. Nothing is published before that approval, and a release in progress is never cancelled by a newer run.

6. **Verify the release.** Download one installer and check it against `SHA256SUMS.txt`; pull the image and hit `/healthz`:

   ```bash
   sha256sum -c SHA256SUMS.txt --ignore-missing
   docker run --rm -p 127.0.0.1:8080:3001 ghcr.io/jaychandra1/kubepilot:v1.2.0
   curl http://127.0.0.1:8080/healthz
   ```

**Manual trigger.** Actions → *Build & Release* → *Run workflow* is accepted only from `main`; it releases whatever `VERSION` says, and the tag `v<VERSION>` must already exist.

### 3.2 Building installers locally (without CI)

```bash
npm run dist          # current OS: downloads+verifies Trivy, builds the UI, packages → release/
npm run app:pack      # macOS only: unpacked .app in release/ for quick testing
npm run app           # run the Electron shell against the current source
```

Outputs in `release/`: `KubePilot-macos.dmg` (Apple Silicon), `KubePilot-windows.exe` (NSIS), `KubePilot-linux.AppImage` and `KubePilot-linux.deb`. Packaging for macOS requires a Mac; Windows requires Windows (or Wine), Linux requires Linux. Builds are ad-hoc signed; to notarize, obtain a Developer ID, set `hardenedRuntime: true` in `package.json` (the entitlements file is already in `build/`) and provide signing credentials.

### 3.3 Building the Docker image locally

```bash
docker build -t kubepilot:dev .
docker run --rm -p 127.0.0.1:8080:3001 -e KUBEPILOT_TOKEN=local-dev-token-1234 \
  -v "$HOME/.kube:/home/node/.kube:ro" kubepilot:dev
```

The image is multi-stage: the client is built, production dependencies are installed with `--ignore-scripts`, and `kubectl`, `kubelogin` and `trivy` are downloaded at pinned versions and verified against their published SHA256 checksums. The container runs as the unprivileged `node` user and exposes a `HEALTHCHECK` on `/healthz`.

### 3.4 Bumping pinned tools and dependencies

- **kubectl / kubelogin / trivy** — edit the `ARG`s at the top of the `Dockerfile`; keep `TRIVY_VERSION` equal to the constant in `scripts/fetch-trivy.mjs` and `KUBECTL_VERSION` equal to the one in `run.sh`. The checksum verification will fail the build if a download does not match.
- **Base image** — the `node:22-alpine` digest is pinned; Dependabot opens a PR when a new digest is published.
- **npm packages and GitHub Actions** — Dependabot opens weekly PRs (root, `client/`, workflows). Actions are pinned to commit SHAs; merge the Dependabot PR rather than editing the SHA by hand.
- After any bump: `npm ci --ignore-scripts && npm rebuild node-pty && npm test && npm run test:client && npm run lint`.

### 3.5 Hotfix flow

1. Branch from the release tag: `git checkout -b hotfix/1.2.1 v1.2.0`.
2. Fix, add a test, update `CHANGELOG.md`.
3. `node scripts/sync-version.mjs 1.2.1`, commit, open a PR to `main`, merge.
4. Tag the merged commit `v1.2.1` and push the tag; the workflow does the rest.

---

## Appendix — Security model in one paragraph

Every API call, the MCP endpoint and the shell WebSocket require a bearer token; only `/healthz` and `/api/version` are public. The server accepts only `localhost`, `127.0.0.1`, `[::1]` (plus `ALLOWED_HOSTS`) as the `Host` header, so a malicious website cannot reach it through DNS rebinding, and cross-origin requests are refused. Every namespace, kind, name, container and port is validated before it reaches `kubectl`, and user values are always placed after a `--` separator. Credentials and kubeconfigs are written atomically with owner-only permissions after a backup. The desktop app sandboxes its renderer, pins navigation to its own backend, passes an allow-listed environment to the backend and ships with Electron fuses. Releases are built from a tag that must match `VERSION`, gated by an approval environment, and published to [jaychandra1/KubePilot](https://github.com/jaychandra1/KubePilot) with checksums and an SBOM. Report vulnerabilities as described in `SECURITY.md`.
