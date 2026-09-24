# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Sidebar is narrower (232 px). The cluster switcher now sits at the left end of the top bar, filling the column above the sidebar, with the Back/Forward arrows right beside it where the content column starts. The top bar no longer reserves the 82 px macOS traffic-light gap on Windows and Linux.
- App icon now uses the official transparent KubePilot artwork (`build/source/icon-detailed.webp` for large sizes, `build/source/icon-simple.webp` for 64 px and below) with no tile behind it, so it sits cleanly on dark and light themes. Windows ships a multi-size `build/icon.ico` (16–256 px); favicon, sidebar, loading screen, splash, website and OG image are regenerated from the same masters, downscaled only.
