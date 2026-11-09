# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- **Image scans send nothing to Aqua Security.** Trivy otherwise sends anonymous usage data to Aqua and asks Aqua's server for update notices on every run, which broke K8Board's no-telemetry promise. Every Trivy run K8Board starts now has both off (`TRIVY_DISABLE_TELEMETRY`, `TRIVY_SKIP_VERSION_CHECK`, overriding the user's environment). They are set as variables rather than flags, so an older Trivy on `PATH` that doesn't know the flags still runs (`test/trivy-telemetry.test.mjs`).
- **The [privacy policy](https://k8dashboard.in/privacy) lists what image scans connect to:** the one-time Trivy download from GitHub, Trivy's vulnerability database (`mirror.gcr.io`, or `ghcr.io` as a fallback) and the registries of the images scanned. It also says where scan results are stored (`~/.config/kubepilot/security-scans/`), names JDG Initiates as the publisher, and drops a sentence about revoking Google access (K8Board has no Google sign-in). The Store certification notes and the user guide say the same.
- **Every High and Critical CodeQL finding is fixed or reviewed** (48 when the gate first ran):
  - **Loading a kubeconfig by path:** the file must still be inside your home folder (or a `KUBECONFIG_DIRS` entry). That check now sits where the path arrives, in a form CodeQL can verify; nothing it allows or refuses changed. This cleared 36 findings across the kubeconfig backup, repair, import and AWS sign-in writes.
  - **Cloud detection:** a cluster's cloud (AWS, Azure, GCP, local) is read from its API server's host name only. A cloud domain in a path, query or user name used to count.
  - **No check-then-use gaps:** the diagnostics log, the Trivy results cache, the version-sync script and the release-key generator read or create files in one step. The key generator still refuses to overwrite an existing key.
  - **Links:** query keys in the app's URL (`#/view?key=value`) are never written as object properties, so a key like `__proto__` can't reach a prototype.
  - **Reviewed, not changed:** the AI assistant calls the LLM endpoint you configure (checked when saved: no cloud-metadata or link-local hosts, `https` off your local network). A Windows `.cmd` tool runs through `cmd.exe` only with arguments free of its metacharacters.
  - **Tests:** a weak 1024-bit RSA test key, unanchored host regexes and a temp file in the shared temp folder were replaced.
- **The Docker image's tools have no fixable HIGH vulnerabilities:**
  - `kubectl` v1.37.0 → v1.37.2 (built with Go 1.26.10).
  - `trivy` 0.74.0 → 0.76.2, also the version the desktop app downloads for image scans.
  - `kubelogin` v1.36.4 is compiled from its tagged source with Go 1.26.10, go-jose 4.1.6 and x/net 0.62.0. No release ships them yet, and its release binary had seven fixed vulnerabilities.
  - Three `x/net`/`x/text` denial-of-service issues in `kubectl` have no release with the fix yet. They are accepted for `kubectl` only, until 2027-01-31.
  - Alpine's packages are upgraded on every CI and release build. A cached `apk upgrade` layer had kept musl 1.2.6-r2 and zlib 1.3.2-r0; builds now get musl 1.2.6-r3 and zlib 1.4 (code-execution fixes).
- **AWS sign-ins reach only what you expect.** With dev and prod clusters on one IAM Identity Center portal, signing in for dev used to renew prod as well. Now:
  - **Only the cluster in use is kept signed in in the background.** Other clusters' sessions renew when you open them.
  - **Production clusters can have their own sign-in.** Preferences → Cloud Integrations → *AWS sign-ins* lists each sign-in, the clusters it covers, and a **Production** switch per cluster. A production cluster's AWS profile moves to a separate `…-production` session with its own token, so a dev sign-in can't reach it.
  - **Sign out** removes a sign-in's stored token from this computer. Clusters stop using cached credentials at once, and signing out of the cluster you're on brings up its sign-in dialog straight away.
  - **An ended sign-in shows as expired.** Once AWS has refused to renew a sign-in (your IAM Identity Center session is over), Preferences shows *Expired — sign in when you open one of its clusters* instead of *Renews when you open one of its clusters*, and Home shows *AWS session expired*. The same goes for a renewal token whose registration has run out, without asking AWS. You can still sign out of an expired sign-in to remove its token.
  - **Signing in changes only the profile you sign in for.** Other older-format profiles for the same portal are no longer rewritten silently; Preferences lists them with an opt-in button. Sign-ins no longer write a second token copy keyed by the portal address, which older-format profiles would have picked up.
  - The "session expired" dialog stays about the cluster you're connecting to. It never names the other clusters a sign-in covers; those are listed in Preferences → Cloud Integrations → AWS sign-ins. A production cluster gets a **Production** tag on its card.
  - Account IDs and the portal address are masked throughout. Every change asks first, and `~/.aws/config` is backed up.
- **All 35 dependency vulnerabilities GitHub reported are fixed** (`npm audit`: 0 in the app and in the client). Updates within the same major version only:
  - **Shipped in the app:** Electron 44.0.0 → 44.10.2 (8 advisories, including the mitigation for the compromised eMudhra certificates); Express 4.22.3 with body-parser 1.20.9 (denial of service via a compressed request body) and qs 6.17.1; zod 4.6.7 (memory exhaustion on oversized input); the MCP SDK 1.32.2 with hono 4.13.16, @hono/node-server 2.1.6 and fast-uri 3.1.9; axios 1.21.0 with follow-redirects 1.16.2 (credential headers kept on cross-origin redirects).
  - **Developer tools:** Vite 8.3.6, Vitest 5.1.0, jsdom 30.1.3 with undici 8.12.4.
  - **Installer builder:** electron-builder 26.18.1 still depends on vulnerable `minimatch` versions, so `package.json` overrides only those (`minimatch@>=7.0.0 <11.0.1` → 11.0.4); the older, unaffected 3.x and 5.x copies are left alone.
  - The minimum versions in `package.json` were raised to the fixed ones, so a fresh install can't fall back.
- **Kubeconfig credential plugins no longer receive K8Board's API token** (2026-11-07 architecture audit, SEC-02). The Kubernetes client starts exec plugins (kubelogin, aws-iam-authenticator, custom scripts) with the backend's own environment, which held the per-launch API token, and also the MCP token and the AI provider's key when they were set as environment variables.
  - **At startup** the backend now takes these out of its environment and keeps them in memory.
  - **Plugin starts** also get the filtered environment K8Board gives every other process.
  - **A new test** runs a stub plugin through the real server, with and without its own `env` in the kubeconfig, and checks what it received.
- **AI agents get logs, events, Helm values and custom resources with credentials masked** (audit SEC-03).
  - **What was exposed:** Secret values were already masked for MCP clients, but free text wasn't. A password printed in a pod log, a token in Helm values, or a credential in a custom resource (an ExternalSecret spec, say) reached the agent and its AI provider.
  - **What's covered now:** every route an agent reads text or arbitrary data from:
    - pod logs, events, Helm values and manifests;
    - custom resources, Argo CD objects;
    - object YAML and resource lists.
  - **How it's masked** (`lib/agent-scrub.mjs`):
    - the built-in assistant's credential patterns;
    - fields named like a credential;
    - env-style name/value pairs;
    - Secret objects inside manifests;
    - JSON kept in annotations.
  - **What stays readable:** fields that only name a secret (`secretName`, `existingSecret`).
  - **Opting out:** Preferences → MCP → *Secret values* turns all of this off. The UI always sees everything.
- **K8Board's secrets set with the new `K8BOARD_` prefix stay out of child processes.** `K8BOARD_TOKEN`, `K8BOARD_SECRET_KEY` and `K8BOARD_MCP_TOKEN` are now removed from the environment of kubectl, helm, credential plugins and terminals, like their `KUBEPILOT_` names (the desktop app sets the latter; Docker and server setups may use either). A test now checks every settings prefix the app reads is covered.

### Changed
- **A new typeface.** K8Board uses Proxima Nova where it's installed and otherwise Figtree, a close match under the SIL Open Font License, bundled with the app so it works offline (one 20 kB file; accented letters load only when needed). Cluster names on Home and in dialogs use it too. Logs, YAML, terminals and resource metrics stay monospace so their columns line up. The website uses the same fonts.
- **Home is shorter and cleaner.** The header shows the logo with the name. The intro is one line: *Welcome back* (or *Welcome to K8Board* on first run), *Choose a cluster to connect. Nothing is contacted until you do.* The separate *Last connected* box is gone: that cluster is tagged *Recently connected* in the list, and its Connect button is the highlighted one.
- **About moved to Help → About K8Board** (macOS: K8Board → About K8Board). It's a dialog with the version, links to the website, privacy policy and terms, the licences, and **Check for Updates**. It's also in the command palette (*About K8Board*). Preferences no longer has an About section.
- **Layout and alignment.**
  - The empty band under the sidebar's logo is gone, and the sidebar header no longer draws a line that didn't meet the tab bar beside it.
  - On windows 1280 px wide or more, a list makes room for the details panel instead of running under it, so the namespace filter, search and **Create** stay visible.
  - The cluster dashboard uses one 16 px gap between all its cards and rows (one section had 40 px), and the node and pod health donuts sit in the middle of their cards.
  - The Security Center title matches the other pages' titles, with its item count under it like on the resource lists.
- **The sign-in dialog shows only the cluster you're connecting to.** It used to repeat the whole cluster list ("Or open a different cluster") and an **Add cluster** button, both already on Home behind it, which made it long enough to scroll. Its footer is now **Back to clusters** and **Retry**. The note listing other clusters the same AWS sign-in covers is gone too.
- **K8Board opens on Home and connects to nothing at startup.** Before, it signed in to the kubeconfig's current context while starting, which could take many seconds, or hang on an offline cluster, before anything showed.
  - **Startup** now reads only the kubeconfig and the app's settings.
  - **Home** lists the last connected cluster, every cluster (pinned and recent first, searchable, with Pin and Remove), and **Add cluster**. Badges come from local files only: production sign-ins, and expired or signed-out AWS sessions.
  - **Connect** runs the steps you can see and cancel (kubeconfig entry, sign-in, cluster summary), then opens the Dashboard. Resources load as their views open.
  - **Failures** open the sign-in dialog, now with **Back to clusters**. **Disconnect** in the cluster menu returns to Home.
  - **Background session renewal** runs only for a connected cluster.
  - **Recent clusters** are remembered.
  - **Optional:** Preferences → General → "Connect to the last cluster at startup" brings back automatic connection; it's off by default.
  - **AI agents (MCP)** can still query the selected cluster when they ask.
- **The Microsoft Store identity is no longer kept in the repository.** `package.json` holds placeholders. Release builds take the Partner Center values from repository variables, and local builds from environment variables: `MS_STORE_IDENTITY_NAME` and `MS_STORE_PUBLISHER` (`scripts/store-identity.mjs`). A placeholder copied into a variable is refused. The Store job refuses to submit an MSIX that doesn't carry them. Only a build with the identity writes `K8Board-windows-store.msix`; any other build writes `K8Board-windows-store-placeholder.msix`, and a release without the variables uploads no Store package (with a warning), so a package Partner Center rejects can't be picked up by mistake.
- **The publisher is JDG Initiates**, the publisher display name of the Partner Center account. It's in `package.json` (the MSIX's publisher display name, the author, the Linux package's vendor and maintainer) and the `LICENSE`. An MSIX built with the old "K8Board Program" placeholder was rejected by Partner Center. `MS_STORE_PUBLISHER_DISPLAY_NAME` is no longer read, and the Store job checks the MSIX's display name too.
- **The KubePilot name is gone from releases and public names.**
  - **Releases** publish the K8Board installers only (no more `KubePilot-*` copies) and the SBOM as `k8board-<tag>.cdx.json`. KubePilot 1.7.3 and older can't find their installer any more: their updater says "No compatible installer" and links to the release page, whose notes say to install once by hand.
  - **Public repository** `jaychandra1/K8Board` (was `jaychandra1/KubePilot`): the release workflow, `releaseRepository`, Docker labels, docs and website. Installed copies from 1.4.0 on follow GitHub's redirect from the old name. **Rename the public repository in GitHub before publishing the next release.**
  - **Docker image** `ghcr.io/jaychandra1/k8board`; the same image is still published as `ghcr.io/jaychandra1/kubepilot` so existing pulls keep updating. After the first release, make the new `k8board` package public and link it to the repository.
  - **Linux:** the `.deb` package and the program are `k8board` (`/usr/bin/k8board`, `k8board.desktop`). The package replaces `kubepilot`, so `apt`/`dpkg` (and the in-app updater) swap them cleanly; a `kubepilot` link next to the program lets an old install restart after that one update.
  - **Settings:** the desktop app passes its settings to the backend as `K8BOARD_…`, and the docs show the `K8BOARD_` names; `KUBEPILOT_…` (and older) names are still read. New backups of kubeconfig and AWS config files are `….k8board-backup-…`. The AWS session name (CloudTrail), the Docker container name in the sign-in screen and user-agent strings say K8Board.
  - **Microsoft Store:** the package is an **MSIX**, `K8Board-windows-store.msix` (`npm run dist:store` builds it locally), with the command alias `k8board.exe`. Partner Center's identity values still need to go into `package.json` before the first upload (docs/store/MICROSOFT-STORE.md).
  - Unchanged on purpose, so installed copies keep updating and keep their data: the signed update text, the app ID, the Windows install folder (`%LOCALAPPDATA%\Programs\kubepilot`), the settings folders (`~/.config/kubepilot`, the `KubePilot` profile), the Kubernetes field manager and the AWS profile prefix.
- **Express 5, React 19 and js-yaml 5.**
  - **Express 4 → 5** (the MCP SDK already used it: one copy now). Routes with an optional namespace use Express 5's syntax (`/api/events{/:namespace}`, `/api/metrics/pods{/:namespace}`) and the UI's catch-all is `/{*splat}`; a request with no body is a clean 400, never a crash.
  - **React 18 → 19.** No code changes needed; no warnings in the browser console.
  - **js-yaml 4 → 5**, through one module, `lib/yaml.mjs`. Manifests can still use anchors with `<<` merge keys (as with kubectl); Kubernetes client objects are dumped as before; YAML written for Kubernetes is byte-for-byte the same. Two improvements: an unquoted date in pasted YAML (`when: 2024-01-01`) now stays that text instead of being re-sent as `2024-01-01T00:00:00.000Z`, and long values in YAML views are no longer folded over several lines.
  - Patch and minor updates: the AWS SDK (3.1163), @kubernetes/client-node 2.0.2, express-rate-limit 8.7.3, ws 8.22.1, globals, prettier; in the client @tanstack/react-virtual 3.14.26, highlight.js 11.12, @vitejs/plugin-react 6.2.1, @testing-library/user-event 14.6.8.
- **Clearer sidebar sections.** The sidebar now reads **Overview** (Dashboard, Nodes, Namespaces, Topology), **Resources** (Workloads, Network, Storage, Config), **Operations** (Events, Helm, Access Control) and **Integrations** (Argo CD, Security Center). The "Cluster" item is now **Dashboard**, in the sidebar and the command palette; its URL (`#/cluster`), icon and page are unchanged. Labels live in `client/src/lib/kinds.js` (`NAV_HEADINGS`, `navLabel`).
- **KubePilot is now K8Board, with a new icon.** In the app and on the website the name is shown as a wordmark: "K", a small "8", "Board" (`client/src/components/ui/Brand.jsx`). It still reads and copies as "K8Board"; plain text (window titles, messages, files) uses "K8Board". The new name appears in:
  - the app, its window and menus;
  - the installers, Start menu and Dock;
  - the MCP setup snippets (`claude mcp add … k8board`);
  - the website, README and docs.

  The icon is a glass tile with a glowing cube cluster. Its tile is transparent, so it works on dark and light taskbars and themes. Small sizes (taskbar, tray, sidebar, favicon) use a simplified single cube that stays crisp. All icons are generated from the SVGs in `build/source/` (`npx electron scripts/generate-icons.cjs`, then `scripts/generate-appx-assets.cjs`).

  **Existing installs update in place and keep everything.** These internal identifiers keep the KubePilot name on purpose; `test/rename-compat.test.mjs` guards them:
  - **Release files:** releases also carry `KubePilot-<os>…` copies of each installer, listed in the signed checksums. Installed KubePilot versions look for that name, and new versions accept either.
  - **Signed text:** the release signature still covers "KubePilot release <version>", the text every installed version verifies.
  - **App ID and Linux package:** the app ID (`com.kubepilot.desktop`) and the Linux package name (`kubepilot`) are unchanged. Windows and `.deb` upgrades replace the old install instead of adding a second app.
  - **Data folders:** `~/.config/kubepilot` and the Electron profile folder keep their names. Clusters, tokens, preferences and the Windows-encrypted secrets stay where they are.
  - **Imported clusters:** kubeconfig entries for imported EKS/AKS clusters that point at the old executable are repointed at the new one on first load.
  - **Environment variables:** `KUBEPILOT_*` still work; `K8BOARD_*` is read first.
  - **Repository:** releases stay at `jaychandra1/KubePilot`.

### Added
- **Help → Export Diagnostics and a log file** (audit OBS-01). Before, the desktop app kept no record of what went wrong, so a reported problem left nothing to look at.
  - **Log file:** the backend's output and the app's own events go to a rotating log in the OS log folder (`k8board.log`, at most 2 MB × 4 files). Tokens, keys and passwords are scrubbed before anything is written. **Help → Open Logs Folder** shows it.
  - **Export Diagnostics:** saves a text file to attach to a bug report:
    - the app, OS and runtime versions;
    - the *shape* of the settings, never their values;
    - the end of the log, with cluster endpoints, IP addresses, AWS account and Azure subscription IDs, emails and your home folder masked.
  - **Request IDs:** every API answer has an `X-Request-Id`, which appears in the log line for that request. A failed request also logs its cause.
- **Release builds need a green CI run** (audit BLD-01). Before, a release ran only the tests, could be cut from any tagged commit, and published with a long-lived personal access token; the scanners only reported.
  - **Release gate:** a release is built only from a commit on `main` whose CI run passed: lint, tests, `npm audit`, CodeQL, Trivy and the new secret scan. It waits for a CI run that's still going.
  - **CodeQL:** High and Critical findings now fail CI (`scripts/sarif-gate.mjs`). This no longer depends on GitHub code scanning being enabled. The log lists every finding with its file and line (GitHub shows only the first 10 annotations), and a reviewed false positive is marked with a `// codeql[<rule-id>]` comment line, with its reason, directly above it.
  - **Trivy:** fixable HIGH and CRITICAL image vulnerabilities fail CI. Accepted exceptions go in `.trivyignore.yaml`, each scoped to one binary, with a reason and an expiry date.
  - **gitleaks:** a new CI job scans new commits for secrets. Test fixtures are allowed in `.gitleaks.toml`.
  - **Image signing:** the GHCR images are signed with cosign (keyless, Sigstore) and verified in the same job.
  - **Publishing token:** uses a short-lived GitHub App token once `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` are set. Until then the `RELEASE_TOKEN` personal access token is used, with a warning.
- **The Dashboard covers the whole cluster, workloads included.** The Workloads → Overview page is gone; what it showed is on the Dashboard, cluster-wide:
  - **New Workloads card:** deployments, statefulsets, daemonsets, jobs, cronjobs and services, each with how many aren't ready, failed or are suspended.
  - **Links:** the nodes, pods and namespaces cards and every workload tile open their list across all namespaces.
  - **Old links:** `#/overview` opens the Dashboard.
- **Remove a cluster from the Switch cluster list.** A trash icon appears on the row you point at or move to with the keyboard, and **Shift+Delete** removes the highlighted cluster. Both open the same confirmation.
- **Remove a cluster.** Use **Remove "<cluster>"…** in the cluster switcher, or **Remove** next to any cluster in Preferences → Kubernetes, which now lists every cluster.
  - **Confirmation:** before anything changes, the dialog shows exactly what goes: the cluster, plus its credentials and server entries, which stay if another cluster uses them.
  - **Safety:** the kubeconfig file that defines the cluster is backed up (`….k8board-backup-<time>`) and then rewritten. kubectl won't see the cluster either.
  - **The cluster you're on** is switched away from first; its pin goes with it.
  - **Its AWS profile** in `~/.aws/config` stays unless you tick the box, which is only offered when no other cluster uses the profile.
  - The AI assistant (MCP) can't remove clusters.
  - Removing a cluster is not signing out: to end a cloud sign-in, use Preferences → Cloud Integrations.
- **Download security reports** (Security Center → an image, a resource or a role → the download icon in the drawer's header), to share with the team that owns it. The reports carry no product name or logo.
  - **PDF report** in the desktop app (A4, page numbers), **HTML report** (one self-contained file; print it to PDF from a browser) and **CSV spreadsheet** (one row per finding, for Excel or Jira).
  - **Resources and roles** (the Resources and Roles tabs) get a configuration audit or RBAC assessment report: executive summary and overall risk, resource details, what to change for each failed check, a card for each critical and high one (every finding message, the check's description, how to fix), the full table, and an appendix. `/api/security/checks` now also returns each failed check's description and all of its messages.
  - **Images** get a vulnerability report with every finding, whatever the drawer is filtered to: executive summary and overall risk, counts per severity, image details, recommended actions with every package upgrade, a detail card for each critical and high CVE (description, CVSS score and vector, published date, references), the full findings table, exposed secrets (location only), changes since the previous version, and an appendix on severity ratings and method.
  - Account IDs, IPs and internal hosts are masked, as everywhere in the UI; the HTML has no scripts and a CSP that blocks every request; CSV cells that would run as spreadsheet formulas are escaped.
  - New route `GET /api/security/vulnerabilities/details?image=` returns one image's advisory details (description, dates, CVSS vector, references) and remediation, from the Trivy Operator or the built-in scan. The built-in scanner now also records them, and each finding's package type and path.
  - The desktop app renders the PDF from the same HTML in a hidden window with JavaScript off, served from memory by a private protocol in its own session that may load nothing else. The page asks for it through a new sandboxed preload (`electron/preload.cjs`) that exposes one function; the main process answers only the app's own page.

- **Edit custom resources.** A custom resource instance (Custom Resources → group → kind → instance) now opens in the same YAML editor as built-in resources. Edit it, then Apply (⌘S / Ctrl+S, after a confirmation) and it is server-side applied like the built-in editor (`kubectl apply --server-side`). The YAML must be the same object (apiVersion, a kind of that resource type, name and namespace), so a paste can't change something else. AI agents can edit only while MCP write access is on. New route: `PUT /api/customresource/:group/:version/:plural/:name`.

- **Trivy Operator scan progress.** The Security Center shows what the operator is doing above its Overview and Images tabs, and refreshes every 10 seconds while scans run:
  - **Status:** how many scans are running (and how many it runs at a time), how many running images have a report ("8 of 32 images scanned"), and when the last report arrived.
  - **When scans stall or fail:** why. This comes from failed scan jobs, scan pods stuck pulling or being scheduled, and errors in the operator's log, shown with account IDs and hosts masked. A hint covers the common causes: private registry access (e.g. ECR read access for the trivy-operator service account), memory, timeouts, quotas and vulnerability-database downloads.
  - **Images tab:** now also lists the images that are waiting, being scanned or failed.
- **Remediation.** An image's details now open with what to do about its vulnerabilities:
  - how many have a fix (and how many of the critical and high ones);
  - whether the fixes are base-image OS packages or application dependencies;
  - a list of package upgrades (installed → upgrade to, and the vulnerabilities each fixes), biggest wins first.

  The Overview's critical list gains a **Fix available** column ("6 of 8").
- **What each rollout fixed.** The Security Center compares each Deployment's running image with its previous image and shows the difference:
  - a **Since last version** column ("▼ 3 fixed", "▲ 1 new") on the Overview, and a **Change** column on the Images tab;
  - a **Fixed since last version** chart on the Overview, by severity;
  - a **Fixed since the previous version** table: each workload, the image change (old → new) and the revisions;
  - a section in the image's details listing every vulnerability fixed or introduced.

  A config-only rollout (same image) is skipped, so the comparison is always against the last image that was actually different.
- **Filter events by namespace, workload, type and text.** The Events page has a filter bar:
  - the namespace picker the other pages use;
  - a **workload** picker;
  - **All / Warnings**;
  - a search over message, reason, object, namespace and source.

  Filters run on the server before paging, so they search every event, not just the first page. "Load more" goes past the first 100. Filters stay in the URL, so the back button and links keep them.

  **Workload filter:** it includes everything the workload owns, because a Deployment's own events are only "Scaled up replica set…" and the useful ones are on its ReplicaSets and Pods:
  - **Deployment:** its ReplicaSets and their Pods, plus its autoscaler;
  - **StatefulSet:** its Pods and volume claims;
  - **CronJob:** its Jobs and their Pods;
  - **DaemonSet / Job:** their Pods.

  The ReplicaSets and Pods a rollout already deleted are matched by their generated names, since their events are often the ones that explain a failed rollout. **View events** in the row menu and the details drawer of Pods and workloads opens the page filtered to that object. New `/api/events` parameters: `type`, `q`, `workload`, `namespaces` (`lib/event-scope.mjs`, shared with demo mode).
- **Cluster Capacity shows the room actually left.** The dashboard card used to compare allocatable with total, which is always about 100%. It now shows, for CPU, memory and pod slots:
  - how much the scheduled pods **request** of what the nodes can run (the share that decides whether new pods fit);
  - what is **in use** right now (with metrics-server);
  - the **limits'** share, flagged above 100% (overcommitted).

  Bars turn amber at 75% requested and red at 90%. The card also says when pods are waiting for a node with room. Requests are added up the way `kubectl describe node` does: the bigger of the app containers and the largest init container, plus native sidecars and pod overhead. Finished and unscheduled pods don't count. The summary API gains `cpuRequestedMilli`, `memRequestedBytes`, `cpuLimitsMilli`, `memLimitsBytes`, `podsScheduled`, `podsAllocatable`, `podsUnscheduled` and `usage` (`lib/capacity.mjs`, shared with demo mode).

### Fixed
- **Submenus closed before you could click them.** In the cluster switcher, *Add cluster ▸ AWS EKS / Azure AKS* disappeared a moment after the pointer moved into it, so it could only be used with the keyboard. Moving into a submenu now keeps it open; it still closes shortly after the pointer leaves both menus. This applies to every menu with a submenu, such as *All contexts ▸* when you have many clusters.
- **A private cluster you can't reach now says what to do, in plain words.** Instead of "Cluster unreachable … private endpoint didn't answer (connection timed out)", the dialog says *Cluster access restricted: This cluster is private. Please connect to the required network (VPN/Tailscale) to access it.* The card says *Private cluster*, and the dialog no longer shows technical details for this case. Retry and Back to clusters are unchanged.
- **The settings gear didn't close Preferences.** Clicking the gear in the sidebar again now closes Preferences and returns to the page you were on, like the close button or Esc. While Preferences is open the gear is highlighted.
- **Website: downloads go to the Microsoft Store only, and no GitHub addresses are shown.**
  - Every download button goes to `website/get.html`, which forwards to K8Board's Microsoft Store page. It's the only page with the Store link; replace `REPLACE-WITH-STORE-ID` there before publishing the site.
  - The Windows card comes first and says *Get it from Microsoft Store*. macOS and Linux show *Coming soon*, with no download.
  - Removed every GitHub link: the hero and footer buttons, release and checksum links, *Release on GitHub*, and the build-from-source section of the docs. The privacy policy, terms and docs give the support email instead of GitHub issues. The Docker section keeps the published image name.
  - `test/website-links.test.mjs` fails if a page shows a GitHub address, links an installer directly, or links the Store anywhere but `get.html`.
- **Website: the privacy and terms pages ignored your theme.** Their theme script was wrapped in two `<script>` tags, so it never ran: the pages always opened light, and the first click on the theme button did nothing.
- **A slow or unreachable cluster or cloud API could leave a view loading indefinitely** (audit REL-02). About two-thirds of the Kubernetes calls, and every AWS and Azure call, had no time limit.
  - **Kubernetes API calls:** now fail after 30 seconds unless the call sets its own limit. Watches, followed logs, shells and port-forwards are unaffected.
  - **AWS:** SDK requests fail after 30 seconds, or 10 seconds to connect.
  - **Azure:** sign-in and Resource Manager requests carry the same 30-second limit.
  - **The UI:** gives up on a request after 5 minutes and says it took too long. That's longer than any of the server's own limits.
- **The Dashboard's pod health counted crash-looping pods as healthy.** It only looked at the pod phase, which stays "Running" while a container is in CrashLoopBackOff, ImagePullBackOff and the like. The Dashboard now counts those pods as failing, by the same rule as the rest of the app (`lib/cluster-health.mjs`, kept in step with the UI by a test). The Pods card says how many are failing.
- **Windows updates restart K8Board much sooner.** An update moves, unpacks and virus-scans every file of the app, and the app was about 5,000 files, almost all in `node_modules`.
  - **Change:** the desktop package now bundles the backend, the token helpers and the MCP bridge into one file each (compacted, names kept), keeping only `node-pty` as files.
  - **Result:** about 220 files instead of about 5,000, and the installer is 10 MB smaller. On a machine with endpoint security, the update's file work went from about 100–150 s to about 10 s.
  - **Store builds:** the Microsoft Store package benefits as well.
- **In the Switch cluster list, ↑/↓ couldn't move off the current cluster** unless you typed a search first.
- **A credential helper that never answered could hold a cluster's requests indefinitely**, and Cancel didn't stop it. Helper runs now give up after 3 minutes, which leaves time for helpers that open a browser sign-in, and Disconnect or Cancel stop a helper that's still running. Found by the 2026-11-07 architecture audit (REL-01).
- **`settings.json` is written atomically**, through a temporary file and a rename. A crash mid-write can no longer leave the pins, MCP switches or recent clusters half-written (audit REL-04).
- **The token helpers did nothing when started through a symlinked path.** This affected `node eks-token.js` and `node azure-token.js` (source and Docker kubeconfigs), and macOS's `/var` → `/private/var` link. Their "run as a script?" check compared paths as plain text, while Node resolves links for the script itself. The helpers exited without a word, and kubectl failed with "Unexpected end of JSON input". Real paths are compared now (`lib/paths.mjs` `isMainModule`). The new bundle tests caught it on the macOS CI runner.
- **When a cluster's sign-in ends, the sign-in dialog comes up instead of endless loading.** Before, signing out (or the AWS session ending) while K8Board was open left the page on loading placeholders, with the sign-in helper's raw output as error messages, until you switched cluster or restarted.
  - **The open cluster's requests now stop at once and the "session expired" dialog opens.** This covers signing out of it, its sign-in being found missing or over, and the 5-minute renewal finding that it can't be renewed. Retry or signing in resumes it.
  - **Requests waiting together share one sign-in helper run.** Before, every request started its own helper (on Windows, a full start of the app runtime), so a busy page launched a burst of them, again on every refresh.
- **The sign-in helper no longer adds "Unable to move the cache: Access is denied", "Gpu Cache Creation failed" and similar lines to its errors.** It now starts without graphics or disk caches, in a storage folder of its own; the server also strips such lines from older helpers' output.
- **Error messages mask account IDs, hosts, IP addresses and tokens**, like the rest of the UI. A sign-in error could show the AWS account ID inside the profile name. This machine's own addresses (`127.0.0.1`, `localhost`) stay readable.
- **A click into a dialog's field right after it opens is no longer undone.** Dialogs moved focus to their first control one frame after opening, even when focus was already inside, so a fast click-and-type (or paste) could land in another control. This also made the Apply-manifests tests fail on the slower CI machines.
- **The desktop app's loading screen shows the new icon** and the K₈Board wordmark. `scripts/generate-icons.cjs` now builds it from the same artwork as every other icon and embeds it in `electron/loading.html`.
- **Vulnerabilities a developer already fixed still showed in the Security Center.** A Deployment keeps its old ReplicaSets (scaled to 0) for rollback, and the Trivy Operator keeps their reports. So after an image was replaced, its old findings stayed in "Latest critical vulnerabilities" and in every total. Only images that are running now are listed and counted. Replaced ones sit behind a "Show N images no longer running" toggle, marked **Not running**, and their details explain why they're still there. Each image's counts now come from its de-duplicated findings: an image used by several workloads was counted once per workload. When a tag is re-pushed, its row shows the findings of the digest that runs.
- **A crash-looping pod showed a green "Running" badge.** Pod status was the bare phase. It now reads like `kubectl get pods`: CrashLoopBackOff, ImagePullBackOff, ContainerCreating, OOMKilled, Completed, Init:1/2, Init:Error, Terminating, Evicted. Those pods now get a red or amber badge, the red row accent, and the right slice in the Overview's pod chart. Native sidecars (init containers with `restartPolicy: Always`) don't hold a pod in Init. The raw phase is still on each row as `phase`.
- **The Pods table's Status column was off-screen at 1280 px wide.** It was the last column, so you had to scroll sideways to see it. It now follows Namespace, close to kubectl's column order.
- **The tab strip above Workloads, Access Control and Argo CD** showed a thick scrollbar under the tabs once they overflowed, and the last tabs were cut off. It now scrolls with the mouse wheel and keyboard, fades on whichever side has more tabs, and keeps the selected tab in view.
- **UI polish from a full screen-by-screen review:**
  - **Status:**
    - Ready/desired counts are coloured: "1/2" amber, "0/1" red with the row accent, "0/0" (scaled down) muted. Every Deployment used to look the same grey.
    - The pod drawer shows the same status as the list (CrashLoopBackOff, not the phase).
  - **Tables:**
    - **Services** show Type as a chip (it isn't a status) and their Ports (`80/TCP, 443:30443/TCP`), never addresses.
    - **Jobs and CronJobs** put Status after Namespace.
    - The last column takes the spare width, so few-column tables (Deployments, Services) stay compact.
    - Header checkboxes and numeric column labels line up with their cells.
    - **Events:** messages wrap, so Count and Age fit at 1280 px. The page header matches the other list pages.
  - **Headers and controls:**
    - **One page-header height everywhere**, aligned with the sidebar brand block.
    - **Top-bar controls** are all 32 px.
    - **Namespace pickers** are 32 px with the app's chevron, replacing a text ▼ and the OS select arrow.
  - **Bottom panel:** Logs and YAML no longer repeat its full-screen and close buttons. The YAML editor keeps its own Close, which asks before discarding edits.
  - **Graphs (Topology and Argo CD):**
    - The zoom controls and node icons keep their intended size.
    - A fitted graph leaves room for the zoom controls, so nodes no longer sit under them.
    - Long kind labels end with an ellipsis.
  - **Argo CD:** the dashboard's sync and health badges line up in columns.
  - **Fonts:** buttons and selects use the app font. The Preferences nav, the theme switch and the Topology chips fell back to Arial.
  - **Preferences:**
    - The Cloud Integrations buttons line up across cards.
    - MCP code blocks fill the column and wrap, with Copy at the top right.
    - The close button no longer shifts when the page scrolls.
  - **Names and wording:**
    - Kind names follow Kubernetes: ReplicaSets, ReplicationControllers, CronJobs, NetworkPolicies, ServiceAccounts, RoleBindings, ClusterRoles, ClusterRoleBindings.
    - The dashboard's memory card says "allocatable", like the CPU card.
  - **Rendering:**
    - No white square where two scrollbars meet.
    - No hairline under highlighted rows.
- **Image names in the Security tables were unreadable.** Long registry prefixes (an ECR host is about 50 characters) filled the cell, so every row looked the same and the image's own name was cut off. Tables now show the image's name and tag first, with the registry and path dimmed underneath, and the whole reference on hover. AWS account IDs in registry hosts are masked (`••••8296.dkr.ecr…`) here, in the details drawer and in table captions.
- **Replica Sets, Jobs, Cron Jobs and Replication Controllers were always empty.** These four views had no data source: the server never listed them, and their rows couldn't be opened in the details drawer or the YAML editor. They are now listed with useful columns:
  - **Replica Sets / Replication Controllers:** desired, current, ready, controlling workload.
  - **Jobs:** completions, duration, owning Cron Job, and Complete / Running / Failed / Suspended status.
  - **Cron Jobs:** schedule, last run, active jobs, and Scheduled / Active / Suspended status.

  Their details and YAML open like other resources. The list-row format now lives in one module shared by the server and demo mode (`lib/resource-format.mjs`), so the two can't drift apart again. Demo mode also lists a ReplicaSet for each Deployment.
- **Deleting a line in the YAML editor now deletes it in the cluster.** Apply used server-side apply, which only removes fields KubePilot itself set. A field set by another tool stayed put: an annotation from `kubectl annotate` or an earlier `kubectl apply` came straight back after you removed it and applied. Both YAML editors (built-in and custom resources) now replace the object with the edited YAML, like `kubectl edit`/`replace`. It's still conditional on the version you loaded (a 409 "changed since you loaded it" otherwise), and the editor now hides `managedFields` like `kubectl get -o yaml`.
- **Recent scan errors** in the Trivy progress banner showed only the start of a failed scan's output: INFO/WARN lines, cut off before the actual error. They now show the scanner's `FATAL`/`ERROR` line, without timestamps, and identical failures are listed once. The operator's routine, retried errors are left out, such as "failed marking old reports for immediate deletion … not found" after a rollout removes an old ReplicaSet. New hints cover scans running out of disk and image tags that no longer exist.
- The Security Center's **Not Scanned** count compared the number of pods with the number of scanned images. It now counts the running images that have no report yet, matched per workload and container the way the operator scans.
- **The pod terminal works without kubectl.** On a machine without kubectl it closed at once, with only "disconnected", because the server refused the session and a browser can't show why. It now opens the same interactive shell through KubePilot's built-in Kubernetes client: typing, colours, resizing, exit codes and the pod's default container all work. kubectl is still used when it's installed. If a session can't open, the terminal says why in plain words ("the pod or container no longer exists", "your user isn't allowed to open a shell in this pod (needs pods/exec)", "the cluster's API server didn't answer"), without hostnames or addresses.
- "Some kinds could not be loaded: deployments (fetch failed)" now gives the reason ("connection timed out", "DNS lookup failed", …).
- The YAML editor reloads the stored object after a successful Apply, so a second edit in a row is no longer refused as a conflict. An edit made while the resource changed in the cluster now says so ("Reload, then apply again") instead of showing a generic upstream error. The server answers 409 `conflict` for it, where it used to answer 502.

## [1.7.0] – 2026-10-21

### Security
- **Signed updates.** Every release's `SHA256SUMS.txt` is now signed with KubePilot's Ed25519 release key (`SHA256SUMS.txt.sig`, bound to the version so an old signed release can't be passed off as a new one), and the in-app updater installs nothing whose signature doesn't verify against a key built into the app. Publishing a release, or a matching checksum, is no longer enough to ship code to installed copies. The release workflow refuses to run until the key is set up (`node scripts/release-signing-keygen.mjs`, then the `RELEASE_SIGNING_KEY` secret of the `release` environment), and checks the secret matches before it signs. Installed builds ignore the test-only trust-key override.
- **A separate token for AI agents.** MCP clients now get their own token (Preferences → MCP, stored in `~/.config/kubepilot/mcp-token`, with **Regenerate**). Requests made with it are MCP requests whatever headers they send, so the write gate holds by construction, and terminals, MCP settings, kubeconfig loading, cloud sign-ins, the assistant, security scans, app settings and updates refuse it. Switching context and stopping port-forwards now count as writes. The token also survives restarts, so desktop MCP configs stop breaking on every launch. Older bridges that still send the API token plus the MCP header keep working, with the same restrictions.
- **Secret values are masked for AI agents.** Over MCP, Kubernetes Secret values, secret-looking environment variables and the `last-applied-configuration` copy of applied data are masked by default (keys, type and metadata stay). A new Preferences → MCP setting, **Secret values: Masked / Visible to agents**, restores the old behaviour. The topology view no longer holds Secret contents in memory.
- **The AI assistant scrubs credentials** (private keys, JWTs, bearer/basic auth, cloud and SaaS API keys, passwords in URLs and `password=…`-style values) from logs, events and object text before they reach the LLM. It also refuses plain `http://` for a provider on the internet; `http://` stays allowed for local and private-network models such as Ollama.
- **Terminals on the KubePilot host are desktop-only.** The AI-agent terminal (and the external agent launcher) now require the desktop app or `KUBEPILOT_LOCAL_SHELL=1`, like the Helm terminal. Its kubeconfig holds only the selected cluster instead of every context. Cluster-controlled text in the agent's seed prompt can no longer run as shell code on Windows.
- **KubePilot's secrets stay out of child processes.** The API token, the secret key, the MCP token and the LLM key are removed from the environment of everything KubePilot starts (kubectl and its credential plugins, az, trivy, pod/Helm/agent terminals). Previously the pod terminal's `KUBE*` allowlist also matched `KUBEPILOT_TOKEN`.
- **The token stays out of production logs.** A production server whose output isn't a terminal (Docker, systemd) no longer prints the login URL with the token. Print it with `node scripts/login-url.mjs` (Docker: `docker exec <container> node scripts/login-url.mjs --base <url>`), or set `KUBEPILOT_PRINT_LOGIN_URL=1` for the old line. `npm start` in a terminal is unchanged.
- WebSocket frames are capped at 1 MiB (the `ws` default was 100 MiB).
- `SECURITY.md` has a real contact address and an updated hardening summary.
- Dependencies: every vulnerable version reported by Dependabot / `npm audit` is patched — `npm audit` now finds 0 vulnerabilities in both lockfiles. Shipped in the app: `proxy-addr` 2.0.8 (critical, IP spoofing; via Express), `compression` 1.8.2, `@modelcontextprotocol/sdk` 1.32.1, `undici`, `http-cache-semantics` 4.3, `js-yaml` 5.5, `ip-address`, `fast-uri`; in the UI bundle `axios` 1.20.0. Build/dev tooling: `shell-quote` 1.12 (critical; via concurrently), `brace-expansion`, `source-map-js` 1.2.2, electron-builder 26.17.0, and an npm override to `global-agent` 4.x, which drops the unmaintained `roarr` → `sprintf-js` chain that has no patched release.

### Added
- **Microsoft Store edition.** The release build also produces a Store package (`KubePilot-windows-store.appx`, uploaded as the `store-kubepilot-windows` workflow artifact). It is signed by Microsoft after certification, so it has no SmartScreen warning, Windows protects its install folder from tampering, and the Store keeps it up to date. It ships with KubePilot's own Start-menu and Store tiles (`build/appx/`, regenerated by `scripts/generate-appx-assets.cjs`) and a `kubepilot.exe` app execution alias, which EKS/AKS kubeconfig entries use as their token helper, so `kubectl` works from any terminal. In the Store edition, Help → Check for Updates offers **Open Microsoft Store** instead of downloading an installer. An optional `store` job submits each release to Partner Center (`MS_STORE_PRODUCT_ID` variable plus four `MS_STORE_*` secrets). See [docs/store/MICROSOFT-STORE.md](docs/store/MICROSOFT-STORE.md) for the step-by-step guide, listing text and local testing.
- **AWS sign-ins renew themselves.** Signing in to IAM Identity Center now asks AWS for a refresh token and stores the login the way `aws configure sso` does — an `[sso-session]` in `~/.aws/config` and its token in `~/.aws/sso/cache` — so the AWS SDK (KubePilot's EKS token helper, the AWS CLI, kubectl) renews the access token without a browser until the Identity Center session ends. KubePilot also renews the sessions behind your EKS contexts ahead of expiry (at launch and every 5 minutes), so the "AWS session expired" dialog only appears when the session itself has ended. Existing SSO profiles are moved to the session format the next time you sign in to them; `~/.aws/config` is backed up once (`config.kubepilot-backup-<time>`) before KubePilot first changes it.
- **Sign in to AWS in one click.** The desktop app opens your AWS access portal in the browser and returns to KubePilot automatically (OAuth 2.0 authorization code + PKCE through a one-time `127.0.0.1` redirect — the AWS CLI's default flow); nothing to type. "Use a sign-in code instead" switches to the device-code flow, which is also what a KubePilot server uses.

### Changed
- The [privacy policy](https://k8dashboard.in/privacy) now covers the GitHub update check, AI agents over MCP (separate token, read-only and Secret values masked by default), the assistant's credential scrubbing, and the Microsoft Store edition.
- The startup **"AWS session expired"** dialog signs the cluster's own profile in right there — no add-cluster wizard, no account/role picking — and reconnects by itself afterwards. It's redesigned around a cluster card (provider, masked account, role, when the session ended) with every step in place (waiting for the browser, the code, signed in, errors with Try again), and keeps any other cluster one click away: the searchable list of every context grouped by provider (AWS, Azure, GKE, on-prem…), or AWS EKS / Azure AKS / kubeconfig tiles when there's nothing to switch to. Nothing opens a browser until you choose to.
- The AWS add-cluster wizard uses the same sign-in panel (browser first, code as fallback) and saves new SSO profiles in the `sso-session` format.
- **Sign-in screens no longer show environment details.** The session-expired dialog and the sign-in panel drop the API server URL and the AWS access portal host, and show AWS account IDs as `••••8296`. Technical details, error messages and suggested commands are masked the same way (cluster endpoints, portal hosts, private hostnames, IP addresses, tenant/subscription IDs and tokens), while Copy still copies the real command. Public documentation links and version numbers are left as they are.

### Fixed
- **"Could not connect to the cluster — fetch failed" now says what went wrong.** A cluster that can't be reached shows **Cluster unreachable**, with the actual failure (connection timed out, refused, DNS lookup failed…). It also says whether this computer was trying the cluster's **public** or **private** endpoint: shown on the cluster card ("AWS EKS · Public endpoint"), plus a matching hint. For example, a cluster you normally reach over Tailscale or a VPN whose name resolves to its public endpoint points you to split DNS or the cluster's allowed public IP ranges. No hostname or address is shown; the underlying error code is under Technical details. Previously a connect timeout (`UND_ERR_CONNECT_TIMEOUT`) wasn't recognised at all.
- The browser page shown after signing in to AWS was a white card with light text in dark mode, and left the one-time authorization code in the address bar. It now follows the system light/dark theme, and the sign-in redirect moves to a clean `/oauth/complete` address so the code is not kept in the URL or browser history. The page sends `no-store`, `no-referrer` and a strict Content-Security-Policy, and the one-time listener shuts down after the page loads (or after 30 seconds).

## [1.5.1] – 2026-10-16

### Fixed
- Docker image: the arm64 image is built on a native arm64 runner instead of under QEMU emulation on an x64 runner, where Node crashed during `npm ci` ("Illegal instruction", exit 132) and the 1.5.0 image could not be published. Both architectures now build natively, are pushed by digest and are combined into one multi-arch tag; the frontend build stage always runs on the build machine's own platform.

## [1.5.0] – 2026-10-16

### Added
- **Full screen for the whole bottom panel** (logs, YAML editor, terminal, node details, Helm release details, Access Control YAML): a maximize button at the right of the tab strip and in each logs / YAML / terminal toolbar expands the panel — its tab strip first, so the other open tabs stay a click away — over the content area while the sidebar and top bar stay visible. The same button (now Minimize) or `Esc` puts it back; `Esc` inside the YAML editor or the terminal is left to them.

### Fixed
- With a details drawer open, the bottom panel ends at the drawer's edge instead of running underneath it, so its tabs and buttons (Reload, Apply, Close, full screen) are no longer hidden — also when maximized. (At 1024 px and below the drawer is full width and still covers the page.)

## [1.4.0] – 2026-10-07

### Added
- **Help menu** in the desktop app (after Window) with **Show Release Notes** — the newest stable release from GitHub, rendered in-app (safe Markdown), with **View on GitHub** — and **Check for Updates**: compares the running version with the newest stable release (semantic versioning; drafts and alpha/beta/rc releases are ignored), and only on **Download and Install** downloads the release file for this OS, CPU and install type, verifies its SHA-256 against GitHub's asset digest and `SHA256SUMS.txt` (a mismatch is deleted, never run), and installs it: Windows silently via the NSIS installer once KubePilot closes (reopening it afterwards, or on the next quit with **Later**), macOS by swapping the app bundle with rollback, Linux by replacing the AppImage or `pkexec dpkg -i`; then **Restart Now** / **Later**. Progress, cancel, and clear messages for offline, rate-limited, missing-installer, verification and install failures. New `lib/updater/` (GitHub release service, version comparison, asset selection, download, verification, installers), `electron/update-host.cjs`, `/api/app/*` routes (refused for MCP clients) and `releaseRepository` in `package.json`; `KUBEPILOT_UPDATE_REPO` / `KUBEPILOT_UPDATE_DRY_RUN` support testing against a scratch release.
- **Full-screen logs**: a Full screen button in every logs viewer (pod and deployment logs, beside Follow) expands the logs over the whole content area while the sidebar and top bar stay visible; the same button (now Minimize) or Esc puts them back in the panel.
- **Apply manifests**: a **Create** button on every resource page opens an editor to create or update resources from YAML (`kubectl apply -f`): paste, open or drop `.yaml`/`.json` files, or start from an example; choose the namespace for manifests without one; **Validate** runs a server-side dry run; **Apply** confirms first and lists each document's result with the API server's reason for any rejection. `POST /api/apply` gained `dryRun`, `namespace` and per-document `results`, validates every document before sending any, and continues past a failed document like kubectl (HTTP 422 `apply_failed`).

### Changed
- README and website screenshots regenerated from the current build (dashboard, AI assistant, topology, command palette, Argo CD dashboard and resource tree, Security Center; dark and light, 2946×1760). They are produced by the new `scripts/capture-screenshots.cjs` (`npm run build && npx electron scripts/capture-screenshots.cjs [views…]`), which drives the built-in demo cluster on a throwaway profile, so no real cluster data appears in them.

### Fixed
- Donut charts (Cluster, Overview, Security): the centre value and its label are centred together inside the ring and scale with it ("97%" no longer touches the ring; the "%" is set smaller), long values shrink to fit, and the Security donuts now show their total in the centre too. Ring and legend line up the same way in every card — legend values flush with the card's right edge, under the header total — and a card too narrow for both centres the ring above the legend. Security donut titles are left-aligned like the dashboard cards, and the Cluster page's Node Roles / Cluster Info row lines up with the cards above it.
- AWS sign-in: after re-authenticating (e.g. an expired SSO session) the cluster list no longer ends on a disabled "Add 0 clusters". It confirms the account and role you signed in as and marks each cluster **Uses this sign-in** (reconnects automatically), **Added** with other credentials (select to switch it to this sign-in) or **Name in use** (a different cluster with the same name, never overwritten); with nothing selected the button is **Done**. The import refuses to overwrite a context that belongs to a different cluster and reports updated clusters separately.
- Dialogs: a confirmation opened over another dialog (e.g. Apply manifests) no longer makes the two focus traps bounce focus between them; only the topmost dialog traps focus.
- Secrets at rest (Windows desktop app): the Azure refresh token (`azure-auth.json`) and the AI provider API key (`config.json`) are now encrypted with AES-256-GCM under a per-user key wrapped by Windows DPAPI (`~/.config/kubepilot/secret.key`), instead of relying on `chmod 0600`, which has no effect on Windows. Existing plaintext values are re-encrypted on first launch; the key is removed from the backend environment as soon as it is read, so child processes never inherit it. The Azure token helper uses its own Chromium profile (`%APPDATA%KubePilot-token-helper`), and Azure tokens are only encrypted once the app has verified, once per version, that the helper can open them; otherwise they stay readable so AKS sign-ins never break. macOS/Linux, dev and Docker runs are unchanged, and AWS keys stay in the standard `~/.aws` files.
- Token helper: an error in `--token-helper` mode now exits with a message on stderr instead of showing an Electron error dialog that would block `kubectl`.
- Desktop app: the update download folder is built with the target OS's path rules (fixes the updater test that failed the macOS and Linux CI builds).

## [1.3.0] – 2026-09-24

### Added
- Logs button beside every name in the Pods and Deployments tables (its own column, right after Name); it opens the logs panel without opening the details drawer. Deployment logs find the pods through the Deployment's selector (new `GET /api/deployments/:namespace/:name/pods`, like `kubectl logs deploy/<name>`) and offer **All pods** — up to 10 replicas merged chronologically, each line prefixed with its pod — or a single replica; a replica that can't be read is flagged instead of failing the whole view. Deployments also get **Logs** in the row menu and the details drawer.

### Changed
- The Cluster page no longer lists the kubeconfig's Contexts and Clusters; it shows Node Roles and Cluster Info only (switch clusters from the top-bar selector).
- The Cluster page shows the branded loading screen ("Getting the data from <cluster>…") until its summary arrives, instead of grey placeholder cards. The loading screen now uses the detailed KubePilot artwork (`client/public/logo-detailed.png`, shown at 120 px).
- Sidebar is narrower (232 px). The cluster switcher now sits at the left end of the top bar, filling the column above the sidebar, with the Back/Forward arrows right beside it where the content column starts. The top bar no longer reserves the 82 px macOS traffic-light gap on Windows and Linux.
- App icon now uses the official transparent KubePilot artwork (`build/source/icon-detailed.webp` for large sizes, `build/source/icon-simple.webp` for 64 px and below) with no tile behind it, so it sits cleanly on dark and light themes. Windows ships a multi-size `build/icon.ico` (16–256 px); favicon, sidebar, loading screen, splash, website and OG image are regenerated from the same masters, downscaled only.

### Fixed
- YAML editor: the caret no longer drifts away from the text. The highlighted layer's `<code>` used the browser's generic monospace font while the editable layer used the app font (a 459-character line was off by about 200 px), and the two layers scrolled separately, so near the bottom the caret sat a line above the typed text. Both layers now share one scroll container and identical typography.
- Dark theme: native dropdown lists (log tail size, pod and container pickers, and every other `<select>`) opened with a light background and the dark theme's pale text. Options now carry explicit theme colours in both themes.
