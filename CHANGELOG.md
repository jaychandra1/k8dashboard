# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **One cluster switcher.** The sidebar's **Context** selector is gone; the cluster name now appears once, in the top-bar cluster menu. The menu covers every case: pinned clusters (check on the current one) → **All contexts** (listed inline with provider icons when there are 12 or fewer, otherwise an **All contexts ▸** submenu) plus **Search contexts…**, which opens a searchable, provider-grouped picker dialog with keyboard navigation → **Pin/Unpin** the current cluster and **Add cluster ▸** (AWS EKS / Azure AKS). The desktop app's native **Clusters ▸ All contexts…** and the `kubepilot:open-contexts` event open the same picker. The auth-error dialog's "Switch to another cluster" uses the same list inline.
- **Cluster Overview is the landing page.** Opening the app without a route, an unknown route, and every cluster switch now land on `#/cluster` (the Cluster overview) instead of the Workloads overview (`#/overview`, still available from the sidebar).
- **Branded loading screen.** Startup (kubeconfig status and cluster authentication) and every cluster switch show the app icon with "Getting the data from <cluster>…" and an indeterminate bar (announced as a polite status; the pulse is disabled under reduced motion). During a switch it covers only the main region — sidebar and top bar stay usable — until the new cluster's summary is on screen, capped at 8 seconds.

### Fixed

- Overview / Cluster KPI row: five cards stay on one row on wide screens and collapse evenly (3+2, 2+2+1) on narrower ones instead of leaving one orphaned card; all cards share the same minimum height.
- Pod Health / Node Health legends no longer truncate labels ("Runn…"); the donut and legend keep a small, consistent gap and the legend wraps under the ring only when the card is really narrow.
- Top bar: back/forward and the cluster switcher share the same 30px height and an even 8–10px rhythm.
- Long menus (e.g. **All contexts ▸** with dozens of clusters) scroll within the window instead of overflowing it.

### Removed

- The built-in demo cluster is no longer shown; the synthetic fixture remains available to tests via `KUBEPILOT_DEMO=1`. The connect screen now offers exactly two paths: load a kubeconfig, or **Add cluster** (AWS EKS / Azure AKS).

### Fixed
- Add AWS EKS: the dialog no longer pre-selects a saved SSO profile (it defaults to entering a start URL; saved profiles are offered explicitly and pre-fill the URL and regions when chosen). A new **Cluster regions** field restricts discovery to the regions you name instead of scanning every AWS region; the server validates the list (`regions` on `POST /api/aws/clusters`).
- Desktop app: the native Clusters menu is no longer rebuilt on a 15-second timer (only on focus, after a switch and on load), which could steal keyboard focus from dialog inputs on Windows.
