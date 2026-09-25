# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Logs button beside every name in the Pods and Deployments tables (its own column, right after Name); it opens the logs panel without opening the details drawer. Deployment logs find the pods through the Deployment's selector (new `GET /api/deployments/:namespace/:name/pods`, like `kubectl logs deploy/<name>`) and offer **All pods** — up to 10 replicas merged chronologically, each line prefixed with its pod — or a single replica; a replica that can't be read is flagged instead of failing the whole view. Deployments also get **Logs** in the row menu and the details drawer.

### Changed
- The Cluster page no longer lists the kubeconfig's Contexts and Clusters; it shows Node Roles and Cluster Info only (switch clusters from the top-bar selector).
- The Cluster page shows the branded loading screen ("Getting the data from <cluster>…") until its summary arrives, instead of grey placeholder cards. The loading screen now uses the detailed KubePilot artwork (`client/public/logo-detailed.png`, shown at 120 px).
- Sidebar is narrower (232 px). The cluster switcher now sits at the left end of the top bar, filling the column above the sidebar, with the Back/Forward arrows right beside it where the content column starts. The top bar no longer reserves the 82 px macOS traffic-light gap on Windows and Linux.
- App icon now uses the official transparent KubePilot artwork (`build/source/icon-detailed.webp` for large sizes, `build/source/icon-simple.webp` for 64 px and below) with no tile behind it, so it sits cleanly on dark and light themes. Windows ships a multi-size `build/icon.ico` (16–256 px); favicon, sidebar, loading screen, splash, website and OG image are regenerated from the same masters, downscaled only.

### Fixed
- Secrets at rest (Windows desktop app): the Azure refresh token (`azure-auth.json`) and the AI provider API key (`config.json`) are now encrypted with AES-256-GCM under a per-user key wrapped by Windows DPAPI (`~/.config/kubepilot/secret.key`), instead of relying on `chmod 0600`, which has no effect on Windows. Existing plaintext values are re-encrypted on first launch; the key is removed from the backend environment as soon as it is read, so child processes never inherit it. The Azure token helper uses its own Chromium profile (`%APPDATA%KubePilot-token-helper`), and Azure tokens are only encrypted once the app has verified, once per version, that the helper can open them; otherwise they stay readable so AKS sign-ins never break. macOS/Linux, dev and Docker runs are unchanged, and AWS keys stay in the standard `~/.aws` files.
- Token helper: an error in `--token-helper` mode now exits with a message on stderr instead of showing an Electron error dialog that would block `kubectl`.
- YAML editor: the caret no longer drifts away from the text. The highlighted layer's `<code>` used the browser's generic monospace font while the editable layer used the app font (a 459-character line was off by about 200 px), and the two layers scrolled separately, so near the bottom the caret sat a line above the typed text. Both layers now share one scroll container and identical typography.
- Dark theme: native dropdown lists (log tail size, pod and container pickers, and every other `<select>`) opened with a light background and the dark theme's pale text. Options now carry explicit theme colours in both themes.

