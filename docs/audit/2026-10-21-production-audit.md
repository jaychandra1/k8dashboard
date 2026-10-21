# KubePilot — Production-Grade Architecture, Security & SRE Audit

| | |
|---|---|
| **Date** | 2026-10-21 |
| **Scope** | Source at `cedddf6` + uncommitted working tree (version 1.6.0 in `VERSION`/`package.json`; last tagged release 1.5.1). Electron desktop app, Express backend, React client, MCP server, Docker image, GitHub Actions pipelines. |
| **Method** | Line-level code reading of every backend module, Electron main process, updater, CI/CD and Dockerfile; full test, lint and build runs (backend 246 pass / 0 fail / 3 skipped; client 222/222; ESLint clean; Vite build OK). Every finding below cites `file:line`. |
| **Not done** | Dynamic penetration testing, real-cluster load tests (10k+ nodes), binary reverse-engineering of release artifacts, verification of GitHub branch-protection settings (not visible from the repo). |
| **Classification** | **Confidential — contains unremediated vulnerability details.** The source repo is private; do not copy this file to the public `KubePilot` release repository until the Critical/High items are closed. |

---

## Remediation status (working tree, 2026-10-21)

The audit below describes the code **as audited**. Since then, the five Critical findings have been addressed in the working tree (not yet released). Every row is backed by tests in `test/updater.test.mjs`, `test/hardening.test.mjs` and `test/mcp-token.test.mjs`.

| Finding | Status | What changed | Still open |
|---|---|---|---|
| **C-1 / R-01** update-channel compromise | **Fixed for updates** | `SHA256SUMS.txt.sig`: an Ed25519 signature over `"KubePilot release <version>\n" + SHA256SUMS.txt` (downgrade-proof). The updater requires it, using keys built into the app; installed builds ignore the test override; CI refuses to release without the key. Microsoft Store edition: signed by Microsoft, tamper-protected install folder, updated by the Store. | GitHub `.exe` is still not Authenticode-signed (needs a paid OV certificate); macOS still unsigned (needs an Apple Developer ID); `asar` and the integrity fuse are still off for GitHub builds. |
| **C-2 / R-02** agent terminal host shell | **Fixed** | Desktop-only gate (same as Helm) at the WebSocket upgrade and on the external launcher; single-context kubeconfig; environment without KubePilot secrets. | — |
| **C-3 / R-03** token leakage | **Fixed** (logs and child processes) | No login URL in non-interactive production logs (`scripts/login-url.mjs` instead); `childEnv()` strips the API/MCP tokens, secret key and LLM key from every spawn; `KUBE(?!PILOT_)` in the pod-terminal allowlist. | The server-mode token still never expires, and WebSocket auth still uses `?token=`. |
| **C-4 / R-04** advisory MCP gate | **Fixed** | Separate MCP token; requests made with it are MCP requests regardless of headers; UI-only route prefixes; context switch and port-forward delete are write-gated; internal `/mcp` sessions use the MCP token. | Old configs that use the UI token keep full power if they omit the header (backward compatibility). |
| **C-5 / R-05** Secret egress to AI | **Fixed for Secrets and the LLM** | MCP masks Secret data, secret-looking env values and last-applied annotations (opt-in toggle); topology drops Secret data; the assistant scrubs credentials from all tool output; `https` required for internet LLM endpoints. | Helm values and ConfigMap data are still visible to agents over MCP. |
| R-11 prompt quoting | **Mitigated** | Windows seed prompts are stripped of every character cmd.exe or PowerShell would interpret; the agent sees one cluster only. | Prompt injection into agents remains inherent to agents. |
| R-17 assistant SSRF/http | **Partly fixed** | `http://` only for loopback and private ranges. | Private ranges are still allowed (by design, for local models). |
| R-18 WebSocket size | **Fixed** | `maxPayload` of 1 MiB. | Upgrade rate-limiting. |
| R-19 hygiene | **Partly fixed** | `SECURITY.md` contact. | `demo.js` still ships; `cors` still declared. |

**Still open High items:** R-06 (no audit log) and R-07 (server mode is single-user). These are the next phase.

---

## 1. Executive Summary

### What this system actually is

KubePilot is a **local-first Kubernetes desktop IDE**: an Electron shell runs a local Express backend (`server.js`) that holds the user's kubeconfig and cloud credentials and talks directly to Kubernetes, AWS, Azure, GitHub and an optional LLM. A Docker image runs the same backend as a browser-accessed server. An MCP server exposes the same capabilities to AI agents.

The audit brief asks for a system "serving millions of users." That phrase has two very different meanings here, and the verdicts differ sharply:

1. **Millions of desktop installs, one user each.** The architecture scales linearly by construction: every user runs their own backend. The risks at that scale are **distribution-channel trust** (one bad release reaches every machine), **update reach**, **field diagnosability**, and **API load on customers' clusters**. Today the first of these is the single biggest risk in the system.
2. **One hosted/shared server for many users.** The current architecture **cannot do this safely**. There is no user identity, one shared non-expiring token, process-global cluster context, no audit trail, and a host shell reachable by any token holder. Server mode is safe only as a single-user deployment behind your own authentication proxy.

### Ratings (1–10)

| Dimension | Score | One-line justification |
|---|:---:|---|
| Architecture | **5** | Sound local-first core and good `lib/` extraction, but a 4,303-line `server.js` monolith, process-global state, and a security model designed for one user being reused for server mode. |
| Security | **5** | Desktop: **6** · Shared server: **3**. Above-average hardening (Electron sandbox, fuses, DNS-rebinding defence, argv-only spawning, validation, PKCE) is undermined by an unsigned release/update chain, an ungated agent shell, an advisory MCP gate and unredacted Secret egress to AI tools. |
| Scalability | **4** | Polling instead of watches, unpaginated lists that silently truncate at 5,000 pods, ~53 Kubernetes calls with no timeout, unbounded fan-out, whole-cache flush on every write. Fine for small/medium clusters; degrades badly on large ones. Server mode cannot run more than one replica. |
| Reliability | **6** | Good supervisor (backend restart with back-off), graceful shutdown, atomic kubeconfig writes with backups, strong integration tests. Weakened by missing timeouts, 128 empty `catch` blocks, non-atomic settings writes and no e2e tests. |
| Maintainability | **5** | Disciplined CHANGELOG, clean lint, 471 tests, SHA-pinned CI. But the riskiest code (`server.js`, `mcp.js`, `trivy-scan.js`) is **absent from the coverage report entirely**, logic is duplicated, and errors are swallowed by policy (`allowEmptyCatch: true`). |

### Key strengths (credit where it's due)

- **Electron hardening is genuinely good**: `contextIsolation`, `sandbox`, no `nodeIntegration`, no preload, `devTools` off in packaged builds, navigation locked to the backend origin, window-open and all permission requests denied, `RunAsNode`/`NODE_OPTIONS`/inspect fuses off (`electron/main.cjs:523-531, 559-573, 781-782`; `electron/after-pack.cjs:76-81`).
- **Injection discipline**: every process is spawned with argv arrays (no shell), identifiers are validated by `lib/validate.mjs` (rejecting leading `-`), kubectl positionals sit after a `--` terminator, and Windows `.cmd` invocations reject cmd metacharacters (`lib/kubectl.mjs:149-224`).
- **Local API defence-in-depth**: random 256-bit bearer token compared in constant time, Host allowlist against DNS rebinding (421), Origin guard, case-normalised routing, strict CSP and security headers, `no-store` on API responses, loopback bind by default (`lib/auth.mjs`; `server.js:127-190, 4296`).
- **Modern auth flows**: AWS IAM Identity Center via authorization code + PKCE with a timing-safe `state` check and a one-time loopback listener; Azure with PKCE + state; credentials written atomically at mode 0600.
- **Supply-chain hygiene in CI**: every action pinned to a commit SHA, `persist-credentials: false`, least-privilege workflow permissions, blocking `npm audit`, CodeQL, digest-pinned base image, checksum-verified kubectl/kubelogin/trivy downloads, CycloneDX SBOM, SHA256SUMS, Dependabot, CODEOWNERS on sensitive paths. `npm audit` reports 0 vulnerabilities.
- **The sign-in UI no longer leaks environment details**: account IDs are masked and endpoints/hosts/IPs/tokens are redacted in the uncommitted changes reviewed here.

### Top risks

1. **The release and update channel is a single point of compromise for the entire install base.** Binaries are unsigned on Windows and macOS. The updater checks only a SHA-256 that comes from the same GitHub release as the binary, then installs silently. `asar` is off and there is no provenance.
2. **Any token holder gets a host shell.** The AI-agent terminal skips the local-shell gate that the Helm terminal enforces. It passes the full process environment and writes a kubeconfig containing every context's credentials.
3. **The MCP write gate is advisory, not a control.** It trusts a header the caller sets itself, while the same full-privilege token is handed to the agent.
4. **Kubernetes Secrets and cluster data flow to AI tools unredacted.** MCP returns full Secret data; logs and ConfigMaps go to a user-configurable (even `http://`) LLM endpoint.
5. **Mutations leave no audit trail.** In server mode every action also runs as one shared identity, so non-repudiation is gone.
6. **Server mode is single-tenant in disguise.** One client switching context silently retargets every other client's next action.

### Critical findings (must fix before any enterprise rollout)

| # | Finding | Evidence |
|---|---|---|
| C-1 | Unsigned binaries + hash-only, same-origin update verification + silent install (`/S`) + `asar` off + non-functional provenance on a private repo → a stolen `RELEASE_TOKEN` or maintainer account ships code to every install | `package.json:76,103-104,134-140`; `lib/updater/verify.mjs:3-11`; `lib/updater/service.mjs:134-146`; `lib/updater/install.mjs:26`; `.github/workflows/release.yml:12-13,239-251` |
| C-2 | `?agent=` WebSocket gives a login shell on the server host to any token holder, including inside Docker, with `{...process.env}` and an all-context kubeconfig | `server.js:4047-4051, 4058-4062` (gate only covers `shell`), `4160-4176` |
| C-3 | API token printed to stdout on every boot (→ `docker logs` and log shippers); never expires; inherited by child processes through a `KUBE` regex prefix that also matches `KUBEPILOT_TOKEN` | `server.js:4301, 4016, 4175`; `electron/main.cjs:285` |
| C-4 | MCP write gate keyed on self-declared `X-KubePilot-Source: mcp`; the same admin token is given to MCP clients; the gate's own toggle and context switching are ungated server-side | `server.js:235-240, 463-469, 489-498, 623`; `lib/paths.mjs:117-121` |
| C-5 | Full Secret `data` returned to MCP clients (`get_resource`, `get_resource_yaml`); topology fetches full Secrets; logs/ConfigMaps/events sent to the LLM unredacted | `server.js:1594-1595, 1635, 1896-1897, 1936, 3507-3519`; `assistant.js:94-117` |

---

## 2. System Architecture Review

### Current architecture

```
 ┌──────────────────────── User's machine (desktop mode) ───────────────────────────┐
 │                                                                                  │
 │  Electron main (main.cjs) ── supervises ──▶ utilityProcess: server.js (Express)  │
 │      │  per-launch token via env                 │  holds: kubeconfig, AWS/Azure │
 │      ▼                                           │  creds, LLM key, API token    │
 │  BrowserWindow (sandboxed React SPA) ──HTTP/WS──▶│  in-memory: currentContext,   │
 │      token in sessionStorage, Bearer / ?token=   │  cache, port-forwards, PTYs   │
 │                                                  │                               │
 │  AI agent CLIs / MCP clients ──stdio/HTTP──────▶ │ ──▶ node-pty: kubectl exec,   │
 │      (same API token)                            │     Helm shell, AGENT SHELL   │
 └──────────────────────────────────────────────────┼───────────────────────────────┘
                                                    ├──▶ Kubernetes API servers (all contexts)
                                                    ├──▶ AWS SSO/OIDC/STS/EKS · Azure AD/ARM
                                                    ├──▶ OpenAI-compatible LLM endpoint (any URL)
                                                    └──▶ GitHub Releases (updates)
 Docker mode: same server.js, HOST=0.0.0.0, token persisted to disk, no Electron.
```

**Trust boundaries that matter:**

- **Renderer → backend.** Well defended: sandbox, CSP, token.
- **Token holder → host.** Weakly defended. Anyone holding the token gets everything the OS user has, plus a shell.
- **AI agent → cluster.** Effectively undefended. The agent holds the admin token; the "gate" is a header the agent chooses whether to send.
- **GitHub release → every install.** Undefended beyond TLS.

### Design assumptions challenged

| Assumption implicit in the design | Reality |
|---|---|
| "Local-first, so the bearer token is the security boundary." | The token boundary is fine for the *UI*. But the backend exposes capabilities **beyond** the user's normal tools (an agent shell from a web socket, an MCP surface for autonomous agents). Any token leak (logs, `/api/mcp/info`, child environments) turns into remote code execution. |
| "The MCP write toggle keeps agents read-only." | It only keeps **well-behaved** agents read-only. A prompt-injected agent with the token can call `DELETE /api/resource` without the header. |
| "SHA-256 verification makes updates safe." | A hash fetched from the same release as the binary proves **integrity in transit**, not **authenticity**. Whoever can publish a release can publish a matching hash. |
| "Server mode is the desktop app in a container." | The desktop security model assumes one person. In a container shared by a team, the global `currentContext` and the single token mean user A's context switch retargets user B's next delete. Every action is also unattributable. |
| "Polling every 60 s is simpler than watches." | It is simpler, until clusters get large. Each refresh issues 11–16 unpaginated list calls per user (`server.js:1443-1453, 3507-3519`). Watches with a shared informer cache cost less and are fresher. |
| "We redact Secrets before sending to the LLM." | Secrets are redacted only in the assistant path. Pod logs — the most common carrier of tokens, connection strings and PII — are not. The MCP path returns Secrets verbatim. |

### Architectural weaknesses

1. **God module.** `server.js` holds 82 routes, the WebSocket terminal multiplexer, kubeconfig mutation, cloud login, Argo, Helm, the security scanner orchestration, MCP session hosting and startup/shutdown in 4,303 lines. Two separate 17-case kind switches (`server.js:1575-1629` and `1877-1931`) show how it has grown by copy-paste.
2. **Process-global mutable state** (`kubeConfig`, `currentContext` at `server.js:72-73`). This makes horizontal scaling impossible and multi-user semantics wrong.
3. **No domain or service layer.** Route handlers call `@kubernetes/client-node` directly (75 `makeApiClient` call sites). There is no single place to enforce timeouts, pagination, redaction, audit or authorization policy. That is exactly why each of those is applied inconsistently.
4. **Three entry points into the same capabilities, each with its own validation**: UI → REST, MCP (zod schemas in `mcp.js:42-52` that differ from `lib/validate.mjs`), and WebSocket (hand-rolled upgrade checks). Policy drift between them is already visible in the agent-shell gate.
5. **Demo mode lives in production.** `demo.js` (1,769 lines, 113 KB) ships in both desktop and Docker artifacts, and `demoActive()` appears inside security gates (`server.js:4060`).

### Target architecture (recommendation)

- **Policy core.** Introduce a single `ClusterGateway` service that every entry point (REST, MCP, WS) goes through. It applies authorization scope, a default timeout, pagination, redaction by caller class, concurrency limits and audit emission. Route handlers become thin.
- **Per-request context.** Pass the context explicitly (header or path), and keep per-context clients in a map. That removes global state and makes server mode correct.
- **Capability-scoped credentials.** Use distinct tokens for UI (full), MCP-read and MCP-write, enforced server-side by token rather than by header.
- **Watch-based cache.** Run one informer set per context, shared across requests and users, with targeted invalidation.
- **A deliberate decision on server mode.** Either declare it single-user and enforce it, or build it properly (Section 13, 3–12 months).

---

## 3. Security Assessment

### 3.1 Authentication

| Control | Implementation | Assessment |
|---|---|---|
| Token generation | 32 random bytes, base64url; env → file (0600, atomic) → generate (`lib/auth.mjs:18-38`) | ✅ Strong entropy. |
| Comparison | `crypto.timingSafeEqual` after a length check (`lib/auth.mjs:40-46`) | ✅ The length leak is negligible because generated tokens have a fixed length. Informational only. |
| Desktop rotation | New token on every launch (`electron/main.cjs:719`) | ✅ Good. |
| Server/Docker rotation | Persisted forever; no expiry, rotation or revocation | ❌ **High.** A leaked token is valid indefinitely. |
| Token in logs | Boot line prints `…/#token=<token>` (`server.js:4301`) | ❌ **High** in server mode. `docker logs`, Kubernetes log collectors and SIEMs all keep a full-admin, non-expiring credential. |
| Token in URLs | WebSocket uses `?token=` (`client/src/lib/api.js:201-206`; `lib/auth.mjs:74-80`) | ⚠️ Medium. Query strings end up in reverse-proxy access logs. Use a one-time, short-lived WS ticket instead. |
| Token disclosure endpoint | `GET /api/mcp/info` returns the raw token (`server.js:463-469`) | ⚠️ By design for the Preferences screen, but it means any XSS or any token holder can mint MCP configurations. |
| Unauthenticated surface | `/healthz`, `/api/version`, static assets (`lib/auth.mjs:62-63`) | ✅ Acceptable. |
| MFA / SSO for the app itself | None | ❌ Needed for any shared deployment. |
| Cloud auth | AWS SSO auth-code + PKCE with timing-safe state (`lib/aws-sso.mjs`); Azure PKCE + state (`azure-aks.js:136-183`), using the Azure CLI's first-party client ID | ✅ Strong. Borrowing the Azure CLI client ID is common but means users consent to "Microsoft Azure CLI", not KubePilot. Register your own app for enterprise tenants. |

### 3.2 Authorization (RBAC / ABAC)

- **There is no RBAC or ABAC inside the application.** Every caller with the token acts as the kubeconfig identity on every context. Kubernetes RBAC on the cluster side is the only real authorization. In server mode that means **everyone gets the container's identity**.
- **The MCP write gate is advisory** (`server.js:235-240`): `isMcpSource(req)` reads `X-KubePilot-Source` (`lib/paths.mjs:117-121`). The stdio config hands the full token to the agent (`server.js:469`; `mcp-stdio.js:30`). Omitting the header bypasses the gate.
- **Security-relevant routes outside the gate**: `POST /api/mcp/config` (the gate's own toggle, `server.js:489`), `POST /api/config/context` (`:623`), `POST /api/config/load` (`:588`), `POST /api/ai-agents/launch-external` (`:1201`), `POST /api/security/scan` (`:2833`), `DELETE /api/portforward/:id` (`:1853`) and the cloud login/import routes.
- **Updater routes** refuse MCP callers using the same self-declared header (`lib/updater/routes.mjs:64-69`), so they are bypassable the same way.

**Recommendation.** Issue a separate MCP credential with explicit scopes (`read`, `write`), enforced by token identity. Make gate configuration, context and kubeconfig management, updater and terminals **UI-token-only**. In multi-user mode, use Kubernetes **impersonation** (`Impersonate-User`/`Impersonate-Group`) so cluster RBAC and audit apply per human.

### 3.3 Secrets management

| Secret | Storage | Assessment |
|---|---|---|
| API token | `~/.config/kubepilot/token`, plaintext, 0600 | ⚠️ OK on single-user machines. Plaintext in Docker volumes. |
| LLM API key | `config.json`; **sealed with AES-256-GCM + DPAPI on Windows only**; plaintext elsewhere; non-atomic write (`assistant.js:29-34`) | ❌ Medium: plaintext on macOS, Linux and Docker. |
| Azure refresh token | `azure-auth.json`, atomic, 0600; sealed on Windows only (`azure-aks.js:56-62`) | ❌ Medium: a long-lived refresh token in plaintext on macOS and Linux. |
| AWS static keys | `~/.aws/credentials`, 0600, atomic (`aws-eks.js:48-57`) | ⚠️ Same as the AWS CLI. Acceptable, but prefer SSO. |
| AWS SSO cache | `~/.aws/sso/cache/*.json` with refreshToken + clientSecret, 0600 | ⚠️ Same as the AWS CLI. Acceptable. |
| Temp kubeconfigs | Agent/external launch: `exportConfig()` = **all contexts with credentials** (`server.js:4161-4165, 1212-1213`); cleanup is an in-process 12 h `setTimeout` (`:1189-1190`) | ❌ Medium: a crash leaves full credential dumps in `/tmp`. The Helm terminal already does the right thing (single pinned context, `server.js:4125-4128`). |
| Backups | `*.kubepilot-backup-<ts>`, one per process per file, three implementations, **never pruned** | ⚠️ Medium: credential sprawl grows with every launch. |

The sealing design (AES-256-GCM, purpose bound as AAD, key wrapped by DPAPI, env var deleted after read, self-test before use) is good. It just needs to exist on every platform: Electron `safeStorage` uses Keychain on macOS and libsecret/kwallet on Linux.

### 3.4 Encryption

- **In transit.** Loopback HTTP on desktop is acceptable. The server has **no TLS option and no HSTS** (`server.js:4004`); Docker binds `0.0.0.0` over plain HTTP. Kubernetes and cloud traffic uses TLS from the kubeconfig and SDKs. The LLM endpoint **may be `http://`** (`assistant.js:495, 517`), which sends cluster data in cleartext.
- **At rest.** Windows only (see 3.3). There is no encryption for caches or backups (acceptable when the directories are 0700).

### 3.5 API security

- ✅ Host allowlist, Origin guard, 4 MB JSON cap, rate limiting (1,000/min/IP, applied before auth), `trust proxy` off by default, consistent JSON errors, `no-store`.
- ⚠️ **No `maxPayload` on the WebSocket server** (`server.js:4025`). The `ws` default of 100 MiB per frame applies, and upgrades are not rate-limited. That is a DoS vector, though it needs the token.
- ⚠️ `X-Requested-With` is sent by the client but never checked. Harmless: CSRF is already impossible without the bearer token.
- ⚠️ When `NODE_ENV !== 'production'`, `localhost:3000` origins are trusted (`lib/auth.mjs:139, 149`), and plain `npm start` doesn't set it. Low: the token is still required.
- ⚠️ The `cors` dependency is declared but unused. Remove it so nobody "fixes" a problem by wiring it in permissively.

### 3.6 OWASP Top 10 (2021) mapping

| Category | Status | Notes |
|---|---|---|
| A01 Broken Access Control | ❌ | Advisory MCP gate; ungated agent shell; ungated gate toggle; no per-user authorization in server mode. |
| A02 Cryptographic Failures | ⚠️ | Plaintext secrets on macOS/Linux/Docker; no TLS in server mode; `http://` LLM allowed. |
| A03 Injection | ✅/⚠️ | Very good argv discipline. Residual: Windows agent prompt typed into a shell (`server.js:4185-4188`); prompt injection into autonomous agents (see 3.7). `/api/exec` running `sh -c` in the pod is by design. |
| A04 Insecure Design | ❌ | Shared global context; the MCP token *is* the admin token; demo code in production gates. |
| A05 Security Misconfiguration | ⚠️ | Dev origins trusted unless `NODE_ENV=production`; Trivy and CodeQL non-blocking; no hardened deployment manifest. |
| A06 Vulnerable Components | ✅ | 0 `npm audit` findings, Dependabot, SHA-pinned actions, digest-pinned base image, checksum-verified binaries. |
| A07 Identification & Authentication Failures | ❌ | Non-expiring shared token in server mode, printed to logs, sent in WS query strings; no MFA or identity. |
| A08 Software & Data Integrity Failures | ❌ **Worst area** | Unsigned binaries, hash-only updates, `asar` + integrity fuse off, provenance attestations fail on a private repo, `KUBEPILOT_UPDATE_REPO` honoured in packaged builds. |
| A09 Logging & Monitoring Failures | ❌ | No audit log; request logs carry no actor or source; no desktop log file. |
| A10 SSRF | ⚠️ | The LLM base-URL guard blocks only metadata and link-local addresses; loopback and RFC 1918 are allowed (`assistant.js:492-507`). The updater has a strict host allowlist ✅. |

### 3.7 Vulnerability findings (detailed)

**V-01 · Critical · Update-channel compromise → code execution on the whole fleet** (C-1)

- **What's wrong.** Windows has no Authenticode signing; macOS has `identity: null` and `hardenedRuntime: false` (ad-hoc signing only).
- **How the updater trusts.** It verifies a SHA-256 from the GitHub asset digest and `SHA256SUMS.txt` — both published by the same actor in the same release. It then runs the NSIS installer silently (`--updated /S`) with no signature check.
- **Exposure.** `asar` is disabled and the per-user install directory is user-writable, so the app's JavaScript can be modified on disk with no integrity check. Provenance attestations are `continue-on-error` and documented as non-functional on private repos.
- **Attack path.** Steal the fine-grained `RELEASE_TOKEN` PAT (or phish the maintainer) → publish a release with a matching checksum → every user who clicks "Download and Install" runs it with access to all their clusters.
- **Secondary issue.** `KUBEPILOT_UPDATE_REPO` is forwarded to the backend in packaged builds (`electron/main.cjs:264`; `lib/updater/github.mjs:39-45`), so a user-level environment variable can silently redirect updates to another repository.

**V-02 · High · Agent terminal = host shell for any token holder** (C-2)

- `?agent=<known-id>` skips `localShellAllowed()`, which is applied only to `?shell=` (`server.js:4058-4062`).
- It spawns a login shell with `{...process.env}` (`server.js:4175`) and a kubeconfig dump of every context (`:4161`).
- In Docker this is arbitrary code execution in the container for anyone with the token, plus exfiltration of every mounted credential. The agent binary doesn't even need to be installed; only a known ID is required.
- No test covers the gating.

**V-03 · High · API token leakage paths** (C-3)

- Printed to stdout on every boot (`server.js:4301`).
- Inherited by child processes:
  - The pod-exec PTY allowlist regex `/^(AWS_|AZURE_|GOOGLE_|KUBE|CLOUDSDK_)/` matches `KUBEPILOT_TOKEN` (`server.js:4016`).
  - The agent PTY gets the full environment (`:4175`).
  - `az` gets `env: process.env` (`:714, 749`).
  - kubectl and its exec credential plugins inherit by default (`lib/kubectl.mjs:163`).
- Only the Helm shell strips `KUBEPILOT_*` (`lib/helm-shell.mjs:75`).
- Any exec-credential plugin, wrapper script or agent CLI can read and exfiltrate the token.

**V-04 · High · Advisory MCP write gate** (C-4) — see 3.2.

**V-05 · High · Unredacted sensitive data to AI tooling** (C-5)

- MCP `get_resource` / `get_resource_yaml` return Secret `data` verbatim.
- Topology fetches full Secrets just to draw edges (`server.js:3507-3519`).
- The assistant redacts Secret `data`/`stringData` and env values whose names look secret (`assistant.js:94-117`). It does **not** redact pod logs, ConfigMap data, events or annotations, all of which routinely carry credentials and personal data. That data goes to an arbitrary, possibly `http://`, endpoint.

**V-06 · Medium · Prompt injection → privilege amplification via agents**

- AI agent prompts include cluster-controlled text, for example Argo `healthMessage` and conditions (`client/src/components/argocd/ArgoCD.jsx:169-176`).
- That text goes to an autonomous agent running in a host shell with an **all-context** kubeconfig.
- Anyone who can write an annotation or a status message in one namespace can therefore try to steer an agent into acting on **other clusters** with the KubePilot user's privileges.
- On Windows the prompt is typed into `cmd.exe` inside double quotes with only quotes and newlines stripped (`server.js:4185-4188`). That allows `%VAR%` expansion; with the `powershell.exe` fallback, `$()` subexpressions execute.
- Severity becomes **High** when users run agents in auto-approve mode.

**V-07 · Medium · Secrets in plaintext at rest on macOS, Linux and Docker** — see 3.3.

**V-08 · Medium · Credential sprawl**

- Temp all-context kubeconfigs survive crashes.
- Backups are never pruned.
- There is no file locking against concurrent `kubectl`/`aws` writes to the same files (risk of lost updates).

**V-09 · Low–Medium · LLM SSRF to private networks** — in server mode a token holder can point the assistant at internal services (`assistant.js:492-507`).

**V-10 · Low · WebSocket DoS** — no `maxPayload`, and upgrades are not rate-limited.

**V-11 · Low · Hygiene**

- The `SECURITY.md` email is a placeholder (GitHub Security Advisories is the working channel).
- Demo code and `scripts/` ship in production images.
- The `cors` dependency is unused.

### 3.8 Dependency & supply-chain security

- ✅ 0 `npm audit` vulnerabilities in both lockfiles; Dependabot weekly for npm, actions and docker; npm overrides used to cut unmaintained chains (`global-agent` 4.x).
- ✅ Docker: base image pinned by digest; kubectl v1.37.0, kubelogin v1.36.4 and trivy 0.74.0 SHA-256-verified; `npm ci --ignore-scripts`; npm and corepack removed from the runtime image; non-root user.
- ✅ GHCR images built with buildx `provenance` and `sbom`.
- ❌ Desktop artifacts: **no signature, no working provenance**. The SBOM exists, but nothing binds it to the binary cryptographically.
- ❌ GHCR images are **not cosign-signed**; consumers cannot enforce signature policy (Kyverno/Gatekeeper/Connaisseur).
- ⚠️ The release pipeline does not rerun lint, `npm audit` or Trivy (gated only on `npm test`, `release.yml:137-138`). Trivy in CI is report-only (`exit-code: '0'`) and CodeQL analysis is `continue-on-error`.
- ⚠️ Publishing uses a long-lived fine-grained PAT. Prefer a GitHub App installation token (short-lived and scoped) or OIDC-based publishing.

### 3.9 Session management

- **Desktop.** The token lives in `sessionStorage`; it is cleared when the tab closes and rotated every launch. Strict CSP (`script-src 'self'`) makes XSS-based theft unlikely. ✅
- **Server.** No session concept, no expiry, no idle timeout, no logout or revocation. ❌
- **MCP sessions.** Evicted after 30 minutes idle (`server.js:3904-3923`) ✅, but they authenticate with the same permanent token.

### 3.10 Logging & audit

- The request log has method, path, status and duration only (`lib/logger.mjs:53-66`). It has **no actor, no source (UI vs MCP vs agent), no context, no resource name and no request ID**. Query strings and headers are correctly excluded ✅.
- **No audit log exists** (zero occurrences of "audit" in the source). Deletes, applies, scales, restarts, execs, Secret reads, context switches and gate toggles leave no trace inside KubePilot. The Kubernetes audit log records only the kubeconfig identity, which in server mode is shared.

### 3.11 PII handling

- Cluster data the app handles routinely includes PII: application logs (emails, IPs, user IDs), events, annotations and ConfigMaps.
- **No data-classification step stands between that data and the LLM**, and the user gets no notice of what leaves the machine.
- ✅ The app has no telemetry. Update checks are manual and contact GitHub only (disclosing IP and version to GitHub; document this).
- ✅ The sign-in UI now masks account IDs and redacts hosts, IPs, tenant IDs and tokens (`client/src/lib/redact.js`).

### 3.12 Infrastructure security posture

The backend is effectively a **credential broker for every cluster in the user's kubeconfig**. Its security posture equals the weakest of: the OS user account, the token's confidentiality, the integrity of the installed files, and the trustworthiness of every agent the user connects. Of those, file integrity (V-01) and token confidentiality (V-03) are currently the weakest.

---

## 4. Database & Data Layer Review

**There is no database, and that is the correct decision for a local client.** The data layer is files plus in-memory state, so this section reviews that layer against the standard a database would be held to.

| Concern | Finding | Risk |
|---|---|---|
| Atomicity | Kubeconfig merges use temp file + rename, mode 0600, and return 409 if the existing file doesn't parse (`server.js:849-890`) ✅. `settings.json` and `config.json` are written **non-atomically** with errors swallowed (`server.js:444-452`; `assistant.js:29-34`). | A crash mid-write corrupts settings or the LLM key; the failure is silent. |
| Concurrency control | **No file locking anywhere.** KubePilot, `kubectl config`, `aws configure` and `az aks get-credentials` all write `~/.kube/config` and `~/.aws/config`. | Lost updates to the user's most critical files: read-modify-write races across tools. |
| Durability / backup | `*.kubepilot-backup-<ts>` taken once per process per file, by **three different implementations** (`server.js:879-884`; `aws-eks.js:175-191`; `lib/kubeconfig-repair.mjs:87-96`), **never pruned**. | Unbounded growth of credential-bearing files; restore is a manual process. |
| Schema / versioning | Settings and config files have no schema version. Legacy dirs and names are handled ad hoc. | Upgrades and downgrades can misread fields; there is no migration framework. |
| Volatile state | Port-forwards, terminals, MCP sessions, scan results and the cache are in memory only. | Lost on every backend restart (which the supervisor does up to 3×/min). Acceptable for desktop; blocks HA in server mode. |
| Caching | LRU of 500 entries / 64 MB, 16 MB per entry, keyed by context, TTL 2–60 s (`lib/cache.mjs`; `server.js:77-84`) ✅. **The whole cache is cleared on every mutation.** | A thundering herd of re-lists after each action, multiplied across users in server mode. |
| Data retention | No retention policy for backups, temp kubeconfigs (in-process 12 h timer) or scan output. | Compliance gap (Section 10). |

**Recommendations:**

1. One `atomicWrite(file, data, mode)` helper (temp + fsync + rename) for every persisted file, plus an advisory lock (`proper-lockfile`) around kubeconfig and AWS config read-modify-write.
2. Consolidate the three backup implementations into one. Keep the last N (e.g. 5) per file and enforce 0600 explicitly.
3. Version the settings schema (`"schemaVersion": 2`) with forward-only migrations.
4. If server mode becomes multi-user, move sessions, audit records and per-user settings to **SQLite (single node) or Postgres (HA)**. Cluster data stays in watch caches, never in a database.

---

## 5. Performance & Scalability Review

### Scale axis 1: cluster size (affects every user)

| Issue | Evidence | Failure mode at scale |
|---|---|---|
| Silent truncation | `listPodForAllNamespaces({limit:5000})` with no `continue` (`server.js:2743, 2841`) | On clusters with >5,000 pods the **security scanner silently skips images** and the "not scanned" count is wrong. A security tool giving false assurance is worse than no tool. |
| Unpaginated lists | Events fetched in full, then paged in memory (`server.js:2106-2125`); resources fan-out (`:1443-1453`). Pagination exists only in the cluster summary and Helm secrets. | Memory spikes of hundreds of MB, multi-second responses, risk of OOM in the 64 MB-cached, single-process backend. |
| Missing timeouts | `requestOptions` with AbortSignal used on 22 calls; **~53 typed calls have none** (namespaces `:1387`, events `:2123`, RBAC `:1530`…) | One slow or partitioned API server pins Express handlers indefinitely, and requests pile up behind it. |
| Unbounded fan-out | `Promise.allSettled` of 11 lists (resources) and 16 (topology, which also pulls **full Secrets**) | Bursts of 16 concurrent full LISTs per user per refresh. On EKS/AKS/GKE this hits API Priority & Fairness throttling and slows *other* workloads' controllers. |
| Polling | Global refresh (default 60 s, `client/src/components/RefreshControl.jsx:8`), Argo 20–30 s, log follow | Constant LIST load proportional to users × views. Watches would cost one long-lived stream per resource type. |
| Cache invalidation | Whole cache flushed on every write | After each apply/scale/delete, every view re-lists everything. |

**Credit:** tables and the logs viewer are virtualized (`client/src/components/ui/DataTable.jsx`, `LogsViewer.jsx`), the client bundle is code-split (largest chunk: xterm at 332 kB, 83 kB gzipped), logs are capped at 20,000 lines / 8 MB, Argo calls run 4 at a time, and terminals are capped at 20.

### Scale axis 2: users

- **Desktop.** Scales linearly by construction: no shared backend to overload. The shared dependencies are GitHub (manual update checks, so no rate-limit storm) and customers' API servers.
- **Server mode.** Single Node process with global state, so it **cannot run more than one replica**. There is no sticky-session story for WebSockets/PTYs, and no shared cache across users. Realistic ceiling: a handful of concurrent users per container, with the correctness problems described in Section 2.

### Recommendations

1. **Gateway wrapper** around all Kubernetes calls: default 15 s timeout, `limit=500` + `continue` pagination, `p-limit` concurrency (e.g. 6 per context), and a `partial: true` flag surfaced in the UI when a list is incomplete.
2. **Metadata-only lists** (`PartialObjectMetadataList`, `Accept: application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1`) for topology and counts. Never fetch Secret bodies to draw a graph.
3. **Informers/watches** per context with `resourceVersion` resume and bookmarks, shared across views (and users in server mode). Push deltas to the UI over the existing WebSocket. Turn polling off when a watch is healthy.
4. **Targeted invalidation**: evict only the kind/namespace that changed.
5. **Load test** against a synthetic cluster (kwok can simulate 10k nodes / 100k pods cheaply) and publish supported limits.

---

## 6. Cloud & Infrastructure Assessment

KubePilot has **no cloud infrastructure of its own**. Its infrastructure is the distribution channel (GitHub Releases on the public `jaychandra1/KubePilot` repo, GHCR) and the Docker runtime.

### Docker image — strong baseline

| ✅ Good | ⚠️ Gap |
|---|---|
| `node:22-alpine` pinned by digest; native multi-arch builds | Plain HTTP, `HOST=0.0.0.0`; nothing in the image or docs enforces a TLS/auth proxy in front |
| Checksum-verified kubectl, kubelogin and trivy | Agent shell reachable in the container (V-02) |
| `USER node`; npm and corepack removed; `--ignore-scripts` | `demo.js` and `scripts/` shipped; bash present (needed for the terminal, but it widens post-exploit tooling) |
| HEALTHCHECK on `/healthz` | Token persisted to the volume and printed to logs (V-03) |
| Host allowlist blocks non-loopback Hosts unless `ALLOWED_HOSTS` is set | No guidance for a read-only root filesystem, dropped capabilities or seccomp |

### Missing for an enterprise deployment

There are **no Kubernetes manifests or Helm chart** for running KubePilot itself. In-cluster users will invent their own, typically with a `cluster-admin` ServiceAccount, no NetworkPolicy and an Ingress without authentication. Ship a hardened chart:

- `runAsNonRoot`, `readOnlyRootFilesystem` (writable `emptyDir` for `/tmp` and config), `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`.
- A least-privilege ServiceAccount: a read-only ClusterRole by default and write verbs opt-in. Use impersonation for per-user RBAC.
- Egress-restricting NetworkPolicy (API server, configured LLM, nothing else). The Ingress fronted by oauth2-proxy/OIDC with TLS.
- cosign-signed images with verification instructions (Kyverno `verifyImages`).
- A distroless or Chainguard Node runtime to drop the shell from images that don't need terminals.

### Platform dependency risk

Updates depend on GitHub availability and on the security of one maintainer account plus one PAT. There is no mirror, no staged rollout and no kill switch for a bad release.

---

## 7. DevOps & CI/CD Review

### Strengths

- `ci.yml`: a 3-OS matrix (Ubuntu, macOS 14, Windows) running lint, `node --check`, backend tests with coverage, client tests and build. Blocking `npm audit --audit-level=high` for root and client. CodeQL security-and-quality. A Docker build with a functional smoke test (healthz, 401 without token, 200 with token). `concurrency` with `cancel-in-progress`.
- Every action is pinned to a commit SHA; `persist-credentials: false`; top-level `permissions: contents: read` (CI) and `{}` (release).
- Release: tag ↔ `VERSION` consistency check, `release` environment approval on the release and docker jobs (the manifest job depends on them), SHA256SUMS, CycloneDX SBOM, and GHCR images with buildx provenance + SBOM on native amd64/arm64 runners.

### Gaps (ranked)

1. **No code signing** on any desktop platform (V-01). This is also an **adoption cost**: SmartScreen and Gatekeeper warnings on every install train users to click through security prompts.
2. **Provenance attestations are dead code**: `continue-on-error` and documented as failing on private repos (`release.yml:12-13, 239-251`). Use **cosign keyless signing** (Sigstore Fulcio/Rekor via GitHub OIDC), which works on private repos, or sign `SHA256SUMS.txt` with minisign using a key held in an HSM or KMS.
3. **Release gates are weaker than CI gates.** The build job runs only `npm test` (`release.yml:137-138`). Lint, audit and Trivy don't run at release time, and a tag can be pushed from a commit whose CI failed. Require the CI workflow's success for the tagged SHA, or rerun all gates.
4. **Non-blocking security scanners.** Trivy `exit-code: '0'`; CodeQL `continue-on-error`. Make HIGH/CRITICAL fail the build, with an explicit, reviewed `.trivyignore` and CodeQL dismissals.
5. **Long-lived publishing credential** (`RELEASE_TOKEN` PAT). Replace it with a GitHub App and short-lived installation tokens, and restrict environment secrets to protected tags.
6. **No secret scanning** in the pipeline (GitHub secret scanning on private repos needs GitHub Advanced Security). Add `gitleaks` or `trufflehog` as a blocking step.
7. **Docs drift**: `release.yml:141` says `npm run dist` fetches trivy; it doesn't (`dist:bundled-trivy` does).
8. Branch protection, required reviews and signed commits can't be verified from the repo. Confirm they're enforced on `main` and on tags (tag protection rules).

---

## 8. Observability & Operations Review

| Capability | State | Assessment |
|---|---|---|
| Structured logs | JSON lines, `LOG_LEVEL`, stdout/stderr (`lib/logger.mjs`) | ✅ Format is good. Content is thin: ~15 `log.info`/`warn` calls in a 4,303-line server. |
| Desktop log persistence | **None.** Backend stdout is forwarded to Electron's stdout (`electron/main.cjs:389`), which goes nowhere for a double-clicked app. | ❌ **When a user reports a bug there are no logs to collect.** Field failures are undiagnosable. |
| Metrics | None (the `/api/metrics/*` routes proxy metrics-server for the *cluster*) | ❌ No request latency, error rate, Kubernetes call latency, cache hit rate, terminal count or memory. |
| Tracing | None | ❌ No correlation between UI action → REST → Kubernetes calls; there isn't even a request ID. |
| Health | `/healthz` returns `{ok, version, uptime}`; no dependency checks, no readiness | ⚠️ Liveness only. A backend with a wedged kubeconfig reports healthy. |
| Crash handling | `uncaughtException` → log + exit 1 ✅; `unhandledRejection` → log only (`server.js:4285-4291`) | ⚠️ A process can continue in an undefined state after an unhandled rejection. |
| Crash reporting | None | ⚠️ Privacy-respecting is good, but you only learn about crashes from GitHub issues. |
| Supervision | Backend restarted up to 3× per 60 s, then a dialog and quit (`electron/main.cjs:396-448`) ✅ | Good pattern. |
| Errors swallowed | 128 empty/comment-only `catch` blocks (41 in `server.js`) + 30 `.catch(() => {})`; lint explicitly allows them | ❌ Hidden failure modes; each one is a place where an incident leaves no trace. |
| Runbooks / SLOs | None | ❌ Expected for server mode. |

**Recommendations:**

1. Rotating log file in `app.getPath('logs')` (5 × 5 MB), plus **Help → Export diagnostics** that bundles logs, version, OS and redacted settings through the existing `redactSensitive` patterns.
2. A request ID (`X-Request-Id`) generated per request and propagated into logs, Kubernetes call logs and audit records.
3. Server mode: a Prometheus `/metrics` endpoint (token-protected) with RED metrics per route and per Kubernetes verb/kind, plus an optional OpenTelemetry exporter.
4. Readiness check (`/readyz`) that verifies the kubeconfig loads and the current context answers `/version` within 2 s.
5. Replace empty catches with `log.debug('…', {err})` at minimum; turn off `allowEmptyCatch` and fix the 128 sites incrementally.
6. Opt-in crash reporting (Electron `crashReporter` to a self-hosted endpoint) with clear consent.

---

## 9. Cost Optimization Assessment

Hosting cost is close to zero because there are no servers to run. The real costs are elsewhere and are not measured today.

| Cost driver | Analysis | Recommendation |
|---|---|---|
| **LLM spend (customer-borne)** | Up to 12 tool iterations per question, each tool output up to 14,000 characters (`assistant.js:20-21, 369`): roughly 40–60k input tokens for a single hard question on a large cluster. No budget, no token accounting, no per-day cap. | Show token usage per answer; daily/monthly caps; summarise tool output before re-prompting; route simple lookups to a cheaper model. |
| **Customer API-server load** | Polling × users × views; full LISTs including Secrets for topology. Managed control planes don't bill per request, but APF throttling degrades customers' own controllers. In server mode this multiplies by user count. | Watches + metadata-only lists (Section 5); this is a cost *and* a reliability fix. |
| **CI minutes** | A 3-OS matrix on every push, including macOS (10× minute multiplier on private repos), plus multi-arch Docker builds. `cancel-in-progress` already helps ✅. | `paths-ignore` for docs-only changes; run macOS and Windows only on PRs to `main` and on release; cache the Electron/node-gyp toolchains. |
| **Trivy scans** | Image pulls for every scanned image hit registry egress and rate limits (Docker Hub). | Cache the vulnerability DB and scan results by image digest; skip unchanged digests. |
| **Support & adoption cost** | Unsigned installers generate SmartScreen/Gatekeeper friction, and enterprise IT blocks unsigned binaries outright. No logs means long back-and-forth on bug reports. | Code signing (~$200–700/yr; Azure Trusted Signing is cheaper) pays for itself quickly; ship diagnostics export. |

---

## 10. Compliance & Governance

KubePilot is a **tool used inside customers' compliance boundaries**. The question is not whether KubePilot is certified, but whether deploying it *breaks* a customer's controls. Today, in server mode, it would.

| Framework | Relevant controls | Status | Gap |
|---|---|---|---|
| **GDPR** | Art. 5(1)(c) data minimisation; Art. 28 processors; Art. 32 security; Art. 44 transfers | ⚠️ | Cluster logs, ConfigMaps and events (often containing personal data) go to a user-configured third-party LLM with no notice, no per-cluster consent and no redaction of personal data. That customer's LLM vendor becomes an unassessed processor with possibly non-EU residency. No telemetry ✅. |
| **SOC 2** | CC6.1/6.2/6.3 logical access; CC7.2 monitoring; CC8.1 change management | ❌ server / ⚠️ desktop | No per-user identity, MFA, access review or audit trail in server mode. Change management in CI is strong ✅, but unsigned releases weaken CC8.1 evidence. |
| **ISO 27001:2022** | A.5.21 ICT supply chain; A.8.5 secure authentication; A.8.15 logging; A.8.24 cryptography; A.8.28 secure coding; A.8.9 configuration management | ⚠️ | Supply chain (no signing or provenance) and logging (no audit) are the failing controls. Secure coding practice is visibly good ✅. |
| **PCI-DSS v4.0** (if used against CDE clusters) | Req 7 least privilege; Req 8 unique IDs + MFA; Req 10 audit trails; Req 6.3.2 software inventory | ❌ | Shared identity and token (fails 8.2.1), no MFA (8.4), no audit trail of admin actions or Secret reads (10.2), Secret values viewable and exportable to AI tools without logging. The SBOM exists ✅ (6.3.2). **Do not deploy server mode against a CDE.** |
| **Audit trail** | — | ❌ | None (Section 3.10). |
| **Data governance** | Classification, retention, egress | ❌ | No data classification, no retention for backups/temp files, no egress policy for AI features. |
| **Risk management** | Threat model, disclosure, support policy | ⚠️ | No written threat model. `SECURITY.md` exists with a working GitHub Security Advisories channel, but the email is a placeholder. No published supported-versions/security-fix policy and no `security.txt`. |

**Governance recommendations:**

1. Publish a **threat model** (STRIDE over the trust boundaries in Section 2) and keep it versioned with the code.
2. Write a **data-flow & AI disclosure** page listing what leaves the machine, to whom, and how to disable it. Add an admin policy file (e.g. `/etc/kubepilot/policy.json` or an MDM-deployable registry key) that can **disable AI features, MCP writes or terminals** fleet-wide. Enterprises will ask for this first.
3. Ship the **audit log** (Section 13) with export to syslog/OTLP.
4. Publish a **security support policy** (latest minor gets fixes; target CVE turnaround) and fix the `SECURITY.md` contact.

---

## 11. Code Quality Review

### Metrics

| Metric | Value |
|---|---|
| Backend size | `server.js` 4,303 · `demo.js` 1,769 · `assistant.js` 566 · `mcp.js` 469 · `lib/` ≈ 2,600 · `lib/updater/` ≈ 1,580 |
| HTTP surface | 93 routes + 1 multiplexed WebSocket (pod / Helm / agent) |
| Client | 123 source files, 16,314 lines; largest component 602 lines |
| Tests | Backend 249 (246 pass, 3 skipped); client 222 (all pass); no e2e |
| Coverage (backend, as reported) | 78.5% lines overall, **but `server.js`, `mcp.js` and `trivy-scan.js` don't appear in the report at all**, because integration tests spawn the server as a subprocess. `assistant.js` 18.6%, `azure-aks.js` 38.2%, `lib/logger.mjs` 37.3%, `lib/pty-helper.mjs` 34.4%, `lib/kubectl.mjs` 59.2%. The headline number excludes the largest and riskiest code. |
| Client coverage | Not configured |
| Lint | Clean; 9 `eslint-disable` (4 × `react-hooks/exhaustive-deps`) |
| Error swallowing | 128 empty catches + 30 `.catch(() => {})`; `allowEmptyCatch: true` in all three lint scopes |
| TODO/FIXME | 0 |

### Strengths

- Clear comments that explain *why*: security decisions are documented inline (for example the WebSocket auth and loopback-bind rationale).
- Real integration tests that boot the actual server with an isolated `HOME`, covering auth (19), HTTP (28), updater (45) and reads (22).
- A centralised validation library; a consistent error envelope (`fail()`, `lib/http-errors.mjs`); the updater is cleanly modular with injectable `fetchImpl` and good tests.
- An excellent CHANGELOG discipline that reads like product documentation.

### Weaknesses

1. **The monolith** (Section 2). Change risk concentrates in one file that the coverage tooling can't see.
2. **Duplication that has already drifted**:
   - Two kind switches (`server.js:1575-1629`, `:1877-1931`).
   - Three backup implementations.
   - Two `shq` quoting helpers (`server.js:1191`, `lib/updater/install.mjs:141`).
   - MCP zod regexes that differ from `lib/validate.mjs` (`mcp.js:42-52`).
   - The agent shell built differently from the Helm shell, which is exactly how the gating gap (V-02) appeared.
3. **Errors swallowed by policy.** Many of the 128 empty catches are legitimate best-effort cleanups, but the lint rule makes it impossible to tell which.
4. **Production carries dev/demo code** (`demo.js`), plus an unused `cors` dependency.
5. **No e2e or Electron UI tests** for the journeys that matter most: sign-in, context switch, apply, delete, terminal and update.
6. **Four `exhaustive-deps` suppressions**, a classic source of stale-closure bugs in React. Each needs a comment justifying it, or a `useEvent`-style refactor.

### Recommendations

- Split `server.js` into routers: `routes/{resources,workloads,exec,terminals,config,cloud-aws,cloud-azure,argocd,helm,security,mcp}.mjs`, plus a `KindRegistry` (one table: kind → API client, read, list, delete, patch).
- Measure subprocess coverage with `NODE_V8_COVERAGE` + `c8 report`. Set thresholds (start at current values, ratchet up). Add vitest coverage to the client.
- Playwright for Electron: 6–8 smoke journeys against kind or kwok in CI.
- Enforce `no-empty` (without `allowEmptyCatch`) on new code via the lint config's `files` scope.

---

## 12. Risk Register

Severity: Critical / High / Medium / Low. Likelihood: High / Medium / Low. Timeline matches Section 13 (P0 = 0–7 days, P1 = 1–4 weeks, P2 = 1–3 months, P3 = 3–12 months).

| ID | Description | Severity | Business impact | Technical impact | Likelihood | Mitigation | Timeline |
|---|---|---|---|---|---|---|---|
| R-01 | Unsigned binaries; updater trusts a same-origin SHA-256 and installs silently; `asar`/integrity fuse off; provenance non-functional; update repo overridable by env | **Critical** | Brand-ending supply-chain incident; enterprise IT blocks unsigned apps | Code execution as the user on every install, with access to all their clusters | Low–Medium | Authenticode + Developer ID + notarization; updater verifies a signature with a pinned key; ignore `KUBEPILOT_UPDATE_REPO` when packaged; cosign keyless; asar + integrity | P0 (env) · P1 (signing) · P2 (asar) |
| R-02 | Agent terminal gives any token holder a host shell with the full environment and an all-context kubeconfig | **High** | Breach of the host/container and every mounted credential in server deployments | RCE in the container; credential exfiltration | Medium (server) / Low (desktop) | Gate with `localShellAllowed()`; reuse the Helm shell's env allowlist and single-context kubeconfig; add a test | P0 |
| R-03 | Long-lived shared API token printed to logs, sent in WS query strings, returned by `/api/mcp/info`, inherited by child processes (`KUBE` regex) | **High** | Anyone with log access becomes cluster admin through KubePilot | Full API + shell (via R-02) to log readers and child processes | Medium | Stop printing on every boot; fix the `ptyEnv` regex; strip `KUBEPILOT_*` from all children; WS one-time tickets; token rotation | P0 · P1 |
| R-04 | MCP write gate is header-based; agents hold the admin token; gate toggle and context switching not gated | **High** | False sense of safety around AI agents; destructive change by a misbehaving agent | Delete/apply/scale bypassing the user's "read-only" choice | Medium | Scoped MCP tokens enforced server-side; UI-only routes for gate, context, config and terminals | P0 (routes) · P1 (tokens) |
| R-05 | Secrets returned to MCP verbatim; topology reads full Secrets; logs/ConfigMaps to the LLM unredacted; `http://` endpoints allowed | **High** | Credential and personal-data leakage to third parties; GDPR exposure | Secrets in LLM provider logs and agent transcripts | High (whenever AI is used) | Redact Secret data for non-UI callers; metadata-only topology; HTTPS-only remote LLMs; extended redaction; per-cluster consent | P0 · P2 |
| R-06 | No audit trail of mutations or Secret reads; shared identity in server mode | **High** | Fails SOC 2/ISO/PCI audits; no incident forensics | Non-repudiation impossible | High (certain once audited) | Append-only audit log + export; Kubernetes impersonation per user | P1 · P3 |
| R-07 | Process-global `currentContext`/`kubeConfig` in server mode | **High** (shared) | Destructive action applied to the wrong cluster (e.g. prod instead of dev) | Cross-session retargeting; no HA possible | Medium (shared deployments) | Per-request context; or enforce single-user server mode and document it | P0 (document) · P2 (fix) |
| R-08 | Secrets in plaintext at rest on macOS, Linux and Docker | Medium | Credential theft from disk images, backups and laptops | LLM key, Azure refresh token and API token readable | Medium | `safeStorage` on all desktop OSes; Docker secrets | P1 |
| R-09 | Unpaginated lists; 5,000-pod truncation without `continue` | Medium | Security scanner silently under-reports on large clusters | Incomplete data; memory spikes | High (on large clusters) | Pagination helper; `partial` flags in the UI | P1 |
| R-10 | ~53 Kubernetes calls without timeout; unbounded fan-out; polling; global cache flush | Medium | Sluggish/hung UI on large or slow clusters; load on customer API servers | Request pile-up; APF throttling | Medium | Gateway wrapper (timeout, limit, concurrency); watches; targeted invalidation | P1 · P2 |
| R-11 | Untrusted cluster text in agent prompts → prompt injection with a host shell and all-context credentials; Windows prompt typed into a shell | Medium (High with auto-approve agents) | Cross-cluster compromise steered by a low-privilege tenant | Agent acts beyond the intended cluster | Low–Medium | Single-context kubeconfig; pass prompts via file/env; fence untrusted text as data | P0 · P1 |
| R-12 | Monolith; riskiest code absent from coverage; no e2e tests | Medium | Regressions in security gates ship unnoticed (V-02 is one already) | High change risk | High | Router split, subprocess coverage + thresholds, Electron e2e | P2 |
| R-13 | No desktop log file, metrics, tracing or crash reporting | Medium | Slow support; incidents undiagnosable | Long MTTR | High | Rotating logs + diagnostics export; request IDs; metrics in server mode | P1 · P2 |
| R-14 | Release gates weaker than CI; Trivy/CodeQL non-blocking; long-lived PAT; no secret scanning | Medium | Vulnerable or broken release published | Known HIGH CVEs can ship | Medium | Gate releases on CI success; blocking scanners; GitHub App tokens; gitleaks | P1 · P2 |
| R-15 | Credential sprawl (unpruned backups, crash-surviving temp kubeconfigs) and no locking on shared config files | Medium | More credential copies to protect; corrupted kubeconfig | Lost updates; stale credentials | Medium | One atomic-write + lock helper; prune backups; clean temp files at startup | P1 |
| R-16 | Manual-only update checks | Medium | Fleet stays on vulnerable versions after fixes ship | Slow patch adoption | High | Automatic signed update checks + staged rollout + kill switch (after R-01) | P2 |
| R-17 | Assistant SSRF guard allows loopback and private ranges | Low–Medium | Internal service probing from server deployments | SSRF | Low | Block private ranges unless explicitly allowed by an admin policy | P1 |
| R-18 | WebSocket without `maxPayload`; upgrades not rate-limited | Low | Backend DoS by a token holder | Memory exhaustion | Low | `maxPayload: 1 MiB`; rate-limit upgrades | P0 |
| R-19 | Demo code and scripts in production artifacts; unused `cors` dependency; `SECURITY.md` placeholder email | Low | Larger attack surface; missed vulnerability reports | Dead code reachable through `demoActive()` gates | Low | Exclude from packaging; remove the dependency; fix the contact | P0 · P1 |
| R-20 | Dev origins trusted when `NODE_ENV` is unset (source installs) | Low | — | Weakened Origin defence in depth | Low | Trust dev origins only when an explicit `KUBEPILOT_DEV=1` is set | P1 |

---

## 13. Remediation Roadmap

### 0–7 days — stop the bleeding (all small, high-leverage changes)

1. **Gate the agent terminal** with `localShellAllowed()` (same check as the Helm terminal), build its environment with the Helm shell's allowlist, and give it a **single-context** kubeconfig. Add an integration test that `?agent=` returns 403 in server mode. *(R-02, R-11)*
2. **Fix token inheritance.** Replace `KUBE` in the `ptyEnv` regex with `KUBECONFIG` (already listed) and `KUBE_`; strip `KUBEPILOT_*`, `LLM_*` and `MCP_*` from every child process (`az`, kubectl, PTYs). *(R-03)*
3. **Stop printing the token on every boot** in server mode. Print it only on first generation, or print a hint (`token stored in ~/.config/kubepilot/token`). *(R-03)*
4. **Ignore `KUBEPILOT_UPDATE_REPO` / `KUBEPILOT_UPDATE_DRY_RUN` when `app.isPackaged`.** *(R-01)*
5. **Make security-relevant routes refuse MCP callers server-side**: `/api/mcp/config`, `/api/config/context`, `/api/config/load`, `/api/ai-agents/launch-external`, `/api/security/scan`, terminals. *(R-04)* This is still header-based until step P1-2, but it closes the obvious holes.
6. **Redact Secret `data`/`stringData`** on `get_resource` / `get_resource_yaml` for MCP-sourced calls (metadata + keys only). *(R-05)*
7. **Set `maxPayload`** (1 MiB) on the WebSocketServer. *(R-18)*
8. **Fix the `SECURITY.md` contact**; document that server mode is **single-user** and must sit behind an authenticating TLS proxy. *(R-19, R-07)*
9. **Windows agent prompts**: pass via a temp file or env var read by the agent, never typed into the shell. *(R-11)*

### 1–4 weeks — close the Critical/High findings properly

1. **Code signing**: Windows (Azure Trusted Signing or an EV certificate via a cloud HSM), macOS (Developer ID, `hardenedRuntime: true`, notarization with stapling). Sign `SHA256SUMS.txt` (minisign or cosign keyless) and **pin the public key in the app**. The updater verifies the signature *and*, on Windows/macOS, the OS code signature (Authenticode publisher / `codesign --verify` team ID) before installing. *(R-01)*
2. **Scoped MCP credentials**: a separate token, read scope by default, write scope only while the toggle is on. Enforce by token identity in middleware; drop the header-based check. *(R-04)*
3. **Audit log v1**: append-only JSONL (`~/.config/kubepilot/audit/*.jsonl`, rotated, 0600) with timestamp, request ID, source (UI/MCP/agent), context, verb, kind/namespace/name, result and error code, covering every mutation, exec, Secret read, context switch and gate toggle. Add an in-app viewer and export. *(R-06)*
4. **`safeStorage` sealing on macOS and Linux**, using the existing AES-GCM envelope. *(R-08)*
5. **Kubernetes gateway wrapper**: default 15 s timeout, pagination with `continue`, `p-limit` concurrency, a `partial` flag. Remove the 5,000 cap. *(R-09, R-10)*
6. **Release pipeline**: require the CI run for the tagged SHA to be green (or rerun lint, audit and Trivy); make Trivy fail on HIGH/CRITICAL; make CodeQL blocking; add gitleaks; move publishing to a GitHub App token. *(R-14)*
7. **Desktop logging**: a rotating file in `app.getPath('logs')` plus **Export diagnostics** with redaction; a request ID everywhere. *(R-13)*
8. **One atomic-write + lock helper**; consolidate and prune backups; clean `km-agent-*` / `kp-helm-*` temp files at startup. *(R-15)*
9. **LLM endpoint policy**: HTTPS required for non-loopback hosts; block private ranges unless an admin policy allows them. *(R-05, R-17)*

### 1–3 months — structural fixes

1. **Split `server.js`** into domain routers plus a `KindRegistry`. Route everything through the gateway (Section 2 target architecture). *(R-12)*
2. **Coverage that tells the truth**: subprocess coverage via `NODE_V8_COVERAGE` + c8 for `server.js`/`mcp.js`; thresholds that ratchet up; client coverage. Playwright-Electron e2e for sign-in, context switch, apply/dry-run, delete, terminal and update. *(R-12)*
3. **Watches/informers** per context with a shared cache, delta push to the UI, targeted invalidation and metadata-only topology. *(R-10)*
4. **Per-request context** (`X-KubePilot-Context`) and per-context client map; remove global `currentContext`. *(R-07)*
5. **Enable `asar` + `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar`**: bundle the ESM backend with esbuild into a single file, or keep the backend in `app.asar.unpacked` with a signed integrity manifest checked at startup. *(R-01)*
6. **AI data governance**: per-cluster AI opt-in, extended redaction (JWTs, high-entropy strings, connection strings and emails in logs/ConfigMaps), token budgets and usage display, and an admin policy file to disable AI, MCP writes or terminals. *(R-05)*
7. **Automatic, signed update checks** with staged rollout (percentage-based) and a remote kill switch for bad releases. *(R-16)*
8. **cosign-sign GHCR images**; publish verification docs and a Kyverno policy example. *(R-14)*

### 3–12 months — make server mode a real product (or retire it)

Decide explicitly. If server/team mode is strategic:

1. **Identity**: OIDC login (or a documented oauth2-proxy pattern), per-user sessions with expiry and revocation, optional MFA through the IdP.
2. **Authorization**: Kubernetes **impersonation** per user so cluster RBAC and the Kubernetes audit log attribute actions to humans; an RBAC-aware UI (hide or disable verbs the user lacks via `SelfSubjectAccessReview`).
3. **Stateless, HA backend**: externalise sessions and audit to Postgres; shared informer cache per context; WebSocket/PTY affinity via sticky sessions or a dedicated terminal service.
4. **Hardened Helm chart** (Section 6), NetworkPolicy, PodSecurity `restricted`, least-privilege ServiceAccount.
5. **Operations**: Prometheus metrics, OpenTelemetry traces, SLOs (e.g. p95 list latency under 1 s for clusters under 5k pods; 99.9% availability), runbooks, on-call alerts, audit forwarding to a SIEM.
6. **Assurance**: a written threat model, an external penetration test, a SOC 2-ready control narrative for enterprise buyers, and SLSA Level 3 provenance for every artifact.
7. **Guardrails for destructive operations**: protected contexts and namespaces, typed confirmation for production, mandatory dry-run diff before apply, server-side enforcement (not only UI dialogs).

---

## 14. Final Assessment

| Metric | Score | Basis |
|---|:---:|---|
| **Production readiness** | **60%** desktop (single user) · **30%** shared server | Desktop works, is well tested and well hardened at the process level, but cannot be trusted at fleet scale until releases are signed. Server mode lacks identity, isolation and audit. |
| **Security** | **50%** | Strong engineering in the *small* (sandboxing, injection, validation, auth flows); critical gaps in the *large* (release integrity, capability exposure to token holders and agents, data egress). |
| **Scalability** | **40%** | Linear in users for desktop; degrades on large clusters (no pagination or timeouts, polling); server mode can't scale beyond one replica. |
| **Reliability** | **60%** | Good supervisor, atomic kubeconfig writes, integration tests; undermined by missing timeouts, swallowed errors and no e2e tests. |
| **Operational maturity** | **35%** | No audit log, desktop logs, metrics, tracing, readiness checks, runbooks or SLOs; manual-only updates. |
| **Overall grade** | **C−** | |

### Verdict

As a **single-user desktop tool**, KubePilot is better engineered than most open-source Kubernetes UIs. The Electron hardening, argv discipline, DNS-rebinding defence, PKCE sign-in flows and CI pinning would pass a demanding review on their own.

The overall grade isn't capped by sloppy code. It's capped by **trust-model decisions that don't hold at scale**:

- **Release channel.** An unsigned, hash-only release and update channel means one compromised GitHub credential turns the whole install base into an attack platform against every cluster those users can reach.
- **Token blast radius.** Bolting an agent shell and an MCP surface onto a single bearer token means "token leaked" equals "host owned".
- **AI data flows.** These were built for convenience before governance: Secrets and logs go to third-party models with partial redaction and no admin control.
- **Server mode.** It ships a single-user security model in a multi-user-shaped container.

**The good news is that the top five findings are cheap relative to their impact.** The P0 list is roughly a week of focused work. With P0 + P1 complete (signing, scoped MCP tokens, audit log, timeouts and pagination, desktop logging), this moves to a **solid B** and becomes defensible for enterprise desktop rollout. Reaching an **A** for a multi-user, millions-of-users posture requires the 3–12-month identity/impersonation/HA work. That is a product decision, not a patch.
