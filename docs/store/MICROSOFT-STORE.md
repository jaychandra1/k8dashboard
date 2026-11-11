# Publishing K8Board to the Microsoft Store

K8Board for Windows is distributed through the **Microsoft Store**; the website's download button goes there, and the Store delivers updates. The release workflow still builds the older installer as well:

| | GitHub Releases | Microsoft Store |
|---|---|---|
| File | `K8Board-windows.exe` (NSIS installer) | `K8Board-windows-store.msix` (MSIX) |
| Signed by | Not signed at the OS level (SmartScreen shows "Unknown publisher") | **Microsoft**, after certification — no SmartScreen warning |
| Updates | The Microsoft Store (Check for Updates points there; the installer build no longer updates itself) | The Microsoft Store |
| Install folder | `%LOCALAPPDATA%\Programs\kubepilot` | `C:\Program Files\WindowsApps\…` (read-only; Windows refuses to start a tampered copy) |

The release workflow builds both on every tagged release. The `.msix` is uploaded as the **`store-k8board-windows`** workflow artifact (not to the GitHub release — it only installs through the Store), and the optional `store` job submits it to Partner Center.

---

## 1. One-time setup

1. **Developer account.** Sign up at <https://storedeveloper.microsoft.com> as an individual developer. Registration is free; Microsoft verifies your identity with an ID document and a selfie.
2. **Reserve the name.** Partner Center → **Apps and games** → **New product** → **MSIX or PWA app** → reserve **K8Board** (or the name you want to show).
3. **Give the build the package identity — not the repository.** Partner Center → the product → **Product management → Product identity** shows three values. The first two are never committed: `package.json` keeps placeholders, and builds read the real values from variables (`scripts/store-identity.mjs`), refusing a placeholder.

   | Partner Center field | Where it comes from | In `package.json` |
   |---|---|---|
   | Package/Identity/Name | variable `MS_STORE_IDENTITY_NAME` | placeholder `K8Board.Desktop` |
   | Package/Identity/Publisher | variable `MS_STORE_PUBLISHER` | placeholder `CN=K8Board` |
   | Package/Properties/PublisherDisplayName | `package.json` | `JDG Initiates` (the account's publisher display name) |

   **For release builds:** add the two variables as repository variables (GitHub → Settings → Secrets and variables → Actions → **Variables**). `MS_STORE_PUBLISHER_DISPLAY_NAME` is no longer read; delete it if it's set.

   **For a local build:** set them as environment variables first.

   The `store` job refuses to submit without them, and checks that the built MSIX carries them and the display name. Partner Center rejects a package whose identity or display name doesn't match exactly. If your Partner Center publisher display name changes, update `build.appx.publisherDisplayName`. Note the **Store ID** shown on the same page (it looks like `9NXXXXXXXXXX`); you'll need it in step 4.

## 2. First submission (by hand — Microsoft requires it)

1. Get the MSIX package, `K8Board-windows-store.msix`, either way:
   - **From a release build:** tag a release as usual; when the **Build & Release** run finishes, download the `store-k8board-windows` artifact from the run's summary page and unzip it.
   - **On your Windows machine:** `npm ci && npm ci --prefix client`, then `npm run dist:store`. The package is written to `release/K8Board-windows-store.msix` (electron-builder downloads the Windows packaging tools the first time).

   Either way, build it **after** step 1.3: the package carries the identity from those variables (`npm run dist:store` refuses to build without them). A build without them, such as a plain `npm run dist`, writes `K8Board-windows-store-placeholder.msix` instead. That file installs for local testing (section 5), but Partner Center rejects it with *Invalid package identity name* and *Invalid package publisher name*. A release without the variables uploads no Store package and says so in a warning.
2. Partner Center → the product → **Start your submission**:
   - **Pricing and availability:** Free; choose markets.
   - **Properties:** Category **Developer tools**. Privacy policy URL: `https://k8board.vercel.app/privacy.html`. Website: `https://k8board.vercel.app`. Support contact: `kubepilot.dashboard@gmail.com`.
   - **Age ratings:** complete the questionnaire. K8Board has no user-generated content and no purchases, and it shares no user data with us.
   - **Packages:** upload `K8Board-windows-store.msix`. Device family: Windows 10/11 Desktop.
   - **Store listings:** use the text in [section 6](#6-store-listing-draft) and screenshots from `website/assets/screenshot-*.png` (1366×768 or larger).
   - **Submission options → Restricted capabilities.** Partner Center asks why the package declares `runFullTrust`. Answer:
     > K8Board is a desktop (Win32/Electron) application packaged with the Desktop Bridge. It runs a local backend process, starts kubectl and cloud CLIs (az, aws), opens terminals (ConPTY) and reads/writes the user's kubeconfig and cloud CLI configuration, all of which require a full-trust desktop process.
   - **Notes for certification:**
     > K8Board is a Kubernetes client. It needs access to a Kubernetes cluster through a kubeconfig file (~/.kube/config); without one it still starts and shows how to add a cluster (AWS EKS, Azure AKS, or a kubeconfig file). To test with a cluster, enable Kubernetes in Docker Desktop (Settings → Kubernetes), or create a local cluster with kind (`kind create cluster`), then start K8Board. No account or sign-in with us is needed.
3. Submit. Certification usually takes 1–3 business days.

## 3. What's different in the Store edition

- **Updates come from the Store.** Help → Check for Updates makes no version check of its own (nothing is asked of GitHub): it offers **Open Microsoft Store**, which opens K8Board's Store page. K8Board never installs anything over a Store install. There is no *Show Release Notes* item on Windows; fill in *What's new in this version* in each submission.
- **Token helper alias.** The kubeconfig entries K8Board writes for EKS and AKS run K8Board itself as their token helper. Other programs can't start an exe under `WindowsApps` by path, so the Store package declares an app execution alias, `k8board.exe` (in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which Windows puts on `PATH`). The Store edition writes that alias into kubeconfig, so `kubectl` works from any terminal, and keeps working across Store updates.
- **Settings are shared.** `~/.config/kubepilot`, `~/.kube`, `~/.aws` and `~/.azure` are outside the package, so the Store and GitHub editions see the same clusters and settings. Uninstall the GitHub edition after switching, so kubeconfig entries don't point at two different copies.

## 4. Automating later submissions (optional)

Each tagged release can submit its `.msix` once the product is live:

1. **Microsoft Entra ID app.** Partner Center → **Account settings → User management → Microsoft Entra applications** → add an app (or create one) and give it the **Manager** role. In the Entra admin center, create a **client secret** for it.
2. **GitHub secrets** on the `release` environment (Settings → Environments → release):
   `MS_STORE_TENANT_ID`, `MS_STORE_SELLER_ID`, `MS_STORE_CLIENT_ID`, `MS_STORE_CLIENT_SECRET`.
   The Seller ID is in Partner Center → Account settings → Legal info / Identifiers.
3. **GitHub variable** (Settings → Secrets and variables → Actions → Variables): `MS_STORE_PRODUCT_ID` = the Store ID from step 1.3.

From then on, the `store` job in `.github/workflows/release.yml` runs after the GitHub release is published (and approved). It uses Microsoft's Store CLI (`msstore publish`) to create a new submission with the new package. Microsoft still certifies every submission before it goes live. GitHub Actions can only update **free** products.

## 5. Testing the Store package locally (before submitting)

An unsigned `.msix` installs only on a machine in Developer Mode. These steps change Windows settings, so run them yourself:

1. Settings → System → **For developers** → turn on **Developer Mode**.
2. Unpack the package (`makeappx.exe` ships with the Windows SDK; electron-builder also caches it under `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-*\windows-10\x64\`):

   ```powershell
   makeappx.exe unpack /p K8Board-windows-store.msix /d k8board-msix
   Add-AppxPackage -Register .\k8board-msix\AppxManifest.xml
   ```

3. Start **K8Board** from the Start menu. Check:
   - your clusters load;
   - a pod terminal, the Helm terminal and an AI agent terminal open;
   - AWS/Azure sign-in completes in the browser;
   - `kubectl get ns` works from a separate terminal against an EKS/AKS context that K8Board added (this exercises the `k8board.exe` alias);
   - Help → Check for Updates offers **Open Microsoft Store**.
4. Remove it: `Get-AppxPackage *K8Board* | Remove-AppxPackage`, then turn Developer Mode off again if you don't need it.

## 6. Store listing (draft)

**Product name:** K8Board

**Short description**
> A fast, native desktop app for exploring and operating Kubernetes clusters — dashboards, logs, terminals, Helm, Argo CD and one-click EKS/AKS sign-in.

**Description**
> K8Board puts your whole Kubernetes cluster in one window. Point it at your kubeconfig, or sign in to AWS or Azure in your browser, and get live dashboards, every workload, logs and terminals, without memorising kubectl.
>
> Explore: a live cluster overview with node and pod health; every workload type with live CPU and memory; an interactive topology graph; Custom Resources; Helm releases with values and manifests; Argo CD applications with sync status and resource trees.
>
> Operate: stream and search logs across containers, open a shell in any pod, port-forward, scale, restart, and edit or apply YAML with a server-side dry run first.
>
> Connect: one-click sign-in to AWS IAM Identity Center (SSO) and Azure, with a separate sign-in for each AWS account. K8Board adds your EKS and AKS clusters and keeps your sessions fresh, and adds GKE clusters with your gcloud sign-in. Works with any cluster in your kubeconfig: on-premises, kind, minikube and Docker Desktop.
>
> Secure by design: K8Board runs entirely on your computer. There are no K8Board servers and no telemetry, and your credentials never leave your machine. AI features are optional and bring-your-own-model; Secret values are masked for AI agents by default.
>
> Bring your AI: connect Claude Code, Cursor or any MCP-compatible agent to K8Board's built-in MCP server (read-only by default), or ask the built-in assistant using your own OpenAI-compatible endpoint.

**Features** (one per line)
- Live cluster dashboard with node, pod and workload health
- Logs, pod shells and port-forwarding in one place
- Edit and apply YAML with server-side validation
- Helm releases and Argo CD applications
- One-click AWS SSO and Azure sign-in for EKS and AKS
- Google GKE with your gcloud sign-in; any kubeconfig works too
- Built-in MCP server for AI agents (read-only by default)
- No telemetry; your credentials stay on your device

**Search terms:** Kubernetes, kubectl, EKS, AKS, Helm, Argo CD, DevOps

**Copyright:** © 2026 JDG Initiates · MIT License

**What's new in this version:** copy the release's section from `CHANGELOG.md`.

**Website.** Every download button on k8board.vercel.app goes to the Store through `website/get.html`, the only page that holds the Store link. Both of its links are `https://apps.microsoft.com/detail/9N63V5DDVL9F` (the Store ID from step 1.3). After the listing is live, you can also add the Store badge to `README.md`.
