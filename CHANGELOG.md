# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Sidebar is narrower (232 px) and its header now holds the cluster switcher with the Back/Forward arrows to its right, directly under the brand; the toolbar shows the current page as a muted breadcrumb instead.
- App icon now uses the official transparent KubePilot artwork (`build/source/icon-detailed.webp` for large sizes, `build/source/icon-simple.webp` for 64 px and below) with no tile behind it, so it sits cleanly on dark and light themes. Windows ships a multi-size `build/icon.ico` (16–256 px); favicon, sidebar, loading screen, splash, website and OG image are regenerated from the same masters, downscaled only.
