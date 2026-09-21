#!/usr/bin/env bash
#
# k8sight — install & run helper
#
# Usage:
#   ./run.sh                 Install deps (first run), build the UI, start the app (production)
#   ./run.sh dev             Install deps, run backend + Vite dev server with hot reload
#   ./run.sh install         Install root + client dependencies only
#   ./run.sh build           Build the production UI bundle only
#   ./run.sh --help
#
# Flags:
#   --skip-install           Don't install dependencies (assume node_modules present)
#   --force-install          Reinstall dependencies even if node_modules already exists
#   --no-tools               Don't offer to fetch kubectl/trivy if missing
#
# This script never runs anything with sudo and never pipes a remote script
# into a shell. When kubectl is missing it can download a PINNED release into
# ~/.local/bin (checksum-verified, no privileges needed) or it prints the
# official install instructions. trivy (the Security Center's local image
# scan) is fetched into ./bin by scripts/fetch-trivy.mjs, also pinned and
# checksum-verified. The Helm view reads releases via the Kubernetes API, so
# the helm CLI is not required.
#
# The app reads your local kubeconfig (default ~/.kube/config, or $KUBECONFIG).
# Every request to the API needs the bearer token the server prints at boot
# ("open http://127.0.0.1:3001/#token=…"); set K8SIGHT_TOKEN to choose it.
#
set -euo pipefail

# --- locate repo root (this script's directory) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- ports ---
BACKEND_PORT="${PORT:-3001}"
DEV_UI_PORT=3000

# --- pinned tool versions (keep KUBECTL_VERSION equal to the Dockerfile ARG) ---
KUBECTL_VERSION="v1.37.0"
MIN_NODE_MAJOR=22

# --- colors (disabled when not a TTY) ---
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi
info()  { printf '%s\n' "${BLUE}${BOLD}==>${RESET} ${BOLD}$*${RESET}"; }
ok()    { printf '%s\n' "${GREEN}✓${RESET} $*"; }
warn()  { printf '%s\n' "${YELLOW}!${RESET} $*"; }
err()   { printf '%s\n' "${RED}✗${RESET} $*" >&2; }

# --- parse args ---
MODE="prod"
SKIP_INSTALL=0
FORCE_INSTALL=0
NO_TOOLS=0
for arg in "$@"; do
  case "$arg" in
    dev)              MODE="dev" ;;
    prod|start|run)   MODE="prod" ;;
    install)          MODE="install" ;;
    build)            MODE="build" ;;
    --skip-install)   SKIP_INSTALL=1 ;;
    --force-install)  FORCE_INSTALL=1 ;;
    --no-tools)       NO_TOOLS=1 ;;
    -h|--help)        MODE="help" ;;
    *) err "Unknown argument: $arg"; MODE="help" ;;
  esac
done

if [ "$MODE" = "help" ]; then
  # print the leading comment header (skip the shebang, stop at first code line)
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit 0
fi

# ------------------------------------------------------------------
# Platform detection (naming used by the official release URLs)
# ------------------------------------------------------------------
os_name() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    *)      echo "unknown" ;;
  esac
}
arch_name() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "amd64" ;;
    arm64|aarch64)  echo "arm64" ;;
    *)              echo "unknown" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# ------------------------------------------------------------------
# kubectl — unprivileged, pinned, checksum-verified install into ~/.local/bin
# ------------------------------------------------------------------
print_kubectl_instructions() {
  cat <<EOF
  Install kubectl (any of):
    macOS:   brew install kubectl
    Linux:   see https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/
    Pinned:  ./run.sh will download ${KUBECTL_VERSION} into ~/.local/bin (no sudo) when
             you answer "y" below, verifying the published .sha256 first.
EOF
}

install_kubectl_user() {
  local os arch url tmp expected actual dest
  os="$(os_name)"; arch="$(arch_name)"
  if [ "$os" = "unknown" ] || [ "$arch" = "unknown" ]; then
    err "Can't download kubectl for this platform ($(uname -s)/$(uname -m))."
    return 1
  fi
  url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${os}/${arch}/kubectl"
  tmp="$(mktemp)"
  info "Downloading kubectl ${KUBECTL_VERSION} (${os}/${arch})"
  if ! curl -fsSL --retry 3 -o "$tmp" "$url"; then err "Download failed: $url"; rm -f "$tmp"; return 1; fi
  if ! expected="$(curl -fsSL --retry 3 "${url}.sha256" | tr -d ' \t\r\n')"; then
    err "Could not fetch the checksum for kubectl — refusing to install."; rm -f "$tmp"; return 1
  fi
  if ! actual="$(sha256_of "$tmp")"; then err "No sha256sum/shasum available to verify the download."; rm -f "$tmp"; return 1; fi
  if [ "$expected" != "$actual" ]; then
    err "kubectl checksum mismatch (expected ${expected}, got ${actual}) — refusing to install."
    rm -f "$tmp"; return 1
  fi
  ok "kubectl checksum verified"
  dest="$HOME/.local/bin"
  mkdir -p "$dest"
  chmod 0755 "$tmp"
  mv "$tmp" "$dest/kubectl"
  ok "kubectl installed to $dest/kubectl"
  case ":$PATH:" in
    *":$dest:"*) ;;
    *) warn "Add $dest to your PATH (e.g. export PATH=\"$dest:\$PATH\") to use kubectl."; export PATH="$dest:$PATH" ;;
  esac
}

offer_kubectl() {
  print_kubectl_instructions
  if [ -t 0 ]; then
    printf '%s' "Download kubectl ${KUBECTL_VERSION} into ~/.local/bin now? [y/N] "
    local reply; read -r reply || reply=""
    case "$reply" in y|Y|yes|YES) install_kubectl_user && return 0 ;; esac
  fi
  return 1
}

# ------------------------------------------------------------------
# macOS quarantine cleanup — native addons only
# ------------------------------------------------------------------
# When the project is downloaded via a browser (common in ~/Downloads), macOS
# tags every file with com.apple.quarantine. Gatekeeper then refuses to load
# quarantined native modules (e.g. @rollup/rollup-darwin-arm64/*.node), which
# breaks `vite build` with a misleading "Cannot find module" error. We strip
# the attribute ONLY from native addons under node_modules — never from the
# whole tree — so nothing else loses its provenance.
dequarantine_macos() {
  [ "$(os_name)" = "darwin" ] || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  local n=0 f
  while IFS= read -r -d '' f; do
    if xattr -p com.apple.quarantine "$f" >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "$f" 2>/dev/null || true
      n=$((n + 1))
    fi
  done < <(find "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/client/node_modules" -type f -name '*.node' -print0 2>/dev/null)
  if [ "$n" -gt 0 ]; then ok "Cleared the quarantine flag on $n native addon(s) (node_modules/**/*.node)"; fi
}

# ------------------------------------------------------------------
# Prerequisite checks
# ------------------------------------------------------------------
check_prereqs() {
  info "Checking prerequisites"
  local missing=0

  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is not installed. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org"
    missing=1
  else
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
      err "Node.js ${MIN_NODE_MAJOR}+ required (found $(node -v))."
      missing=1
    else
      ok "Node.js $(node -v)"
    fi
  fi

  if ! command -v npm >/dev/null 2>&1; then
    err "npm is not installed (it ships with Node.js)."
    missing=1
  else
    ok "npm v$(npm -v)"
  fi

  # kubectl is required at runtime (metrics, topology, CRDs, port-forward).
  if ! command -v kubectl >/dev/null 2>&1; then
    if [ "$NO_TOOLS" -eq 1 ]; then
      err "kubectl not found on PATH."
      print_kubectl_instructions
      missing=1
    else
      warn "kubectl not found."
      if offer_kubectl && command -v kubectl >/dev/null 2>&1; then
        ok "kubectl available ($(command -v kubectl))"
      else
        err "kubectl is required. Install it and re-run (or use demo mode in the app without a cluster)."
        missing=1
      fi
    fi
  else
    ok "kubectl present ($(command -v kubectl))"
  fi

  # trivy is optional — it powers the Security Center's local image scan. The
  # app looks in ./bin first, which scripts/fetch-trivy.mjs fills with a
  # pinned, checksum-verified release. Never fatal.
  if command -v trivy >/dev/null 2>&1; then
    ok "trivy present ($(trivy --version 2>/dev/null | head -1))"
  elif [ -x "$SCRIPT_DIR/bin/trivy" ]; then
    ok "trivy present (./bin/trivy $(cat "$SCRIPT_DIR/bin/trivy.version" 2>/dev/null || echo '?'))"
  elif [ "$NO_TOOLS" -eq 1 ]; then
    warn "trivy not found — run 'npm run fetch:trivy' (or 'brew install trivy') to enable local image scans."
  else
    warn "trivy not found — fetching the pinned release into ./bin (checksum-verified)."
    if node scripts/fetch-trivy.mjs; then ok "trivy ready (./bin/trivy)"; else warn "trivy fetch failed; local image scans are disabled until 'npm run fetch:trivy' succeeds."; fi
  fi

  # kubeconfig sanity (non-fatal — the UI also has a path prompt)
  local kcfg="${KUBECONFIG:-$HOME/.kube/config}"
  if [ -f "${kcfg%%:*}" ]; then
    ok "kubeconfig found (${kcfg%%:*})"
  else
    warn "No kubeconfig at ${kcfg%%:*}. You can enter a path in the app when it loads, or use demo mode."
  fi

  if [ "$missing" -ne 0 ]; then
    err "Missing required tools. Please install them and re-run."
    exit 1
  fi
}

# ------------------------------------------------------------------
# Dependency install
# ------------------------------------------------------------------
# `npm ci` when a lockfile exists (reproducible), `npm install` otherwise.
# Lifecycle scripts are disabled for the install itself; the two things we
# need from them run explicitly afterwards (node-pty native build, exec bit).
npm_install_in() {
  local dir="$1"
  (
    cd "$dir"
    if [ "$FORCE_INSTALL" -eq 0 ] && [ -f package-lock.json ]; then
      npm ci --ignore-scripts
    else
      npm install --ignore-scripts
    fi
  )
}

install_deps() {
  if [ "$SKIP_INSTALL" -eq 1 ]; then
    warn "Skipping dependency install (--skip-install)"
    return
  fi

  if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d node_modules ]; then
    info "Installing backend dependencies"
    npm_install_in "$SCRIPT_DIR"
    npm rebuild node-pty --foreground-scripts
    node scripts/fix-pty-helper.mjs
    ok "Backend dependencies installed"
  else
    ok "Backend dependencies already installed (use --force-install to reinstall)"
  fi

  if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d client/node_modules ]; then
    info "Installing frontend dependencies"
    npm_install_in "$SCRIPT_DIR/client"
    ok "Frontend dependencies installed"
  else
    ok "Frontend dependencies already installed"
  fi
}

# ------------------------------------------------------------------
# Build production UI
# ------------------------------------------------------------------
build_ui() {
  info "Building production UI bundle"
  ( cd client && npm run build )
  ok "UI built into client/dist"
}

# ------------------------------------------------------------------
# Port guard
# ------------------------------------------------------------------
port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

warn_if_busy() {
  local p="$1" label="$2"
  if port_in_use "$p"; then
    warn "Port $p ($label) is already in use — the app may fail to bind. Free it or set PORT=<other>."
  fi
}

# ------------------------------------------------------------------
# Run
# ------------------------------------------------------------------
run_prod() {
  warn_if_busy "$BACKEND_PORT" "backend + UI"
  info "Starting k8sight (production)"
  printf '%s\n' "${DIM}The server prints a login URL with your access token — open that URL, not the bare port. Ctrl+C to stop.${RESET}"
  exec node server.js
}

run_dev() {
  warn_if_busy "$BACKEND_PORT" "backend/API"
  warn_if_busy "$DEV_UI_PORT" "Vite dev server"
  info "Starting k8sight (dev — hot reload)"
  printf '%s\n' "${DIM}UI: ${RESET}${BOLD}http://localhost:${DEV_UI_PORT}${RESET}${DIM}  (API proxied to :${BACKEND_PORT}; append the #token=… fragment printed by the server) — Ctrl+C to stop.${RESET}"
  exec npm run dev
}

# ------------------------------------------------------------------
# main
# ------------------------------------------------------------------
check_prereqs

case "$MODE" in
  install)
    install_deps
    dequarantine_macos
    ok "Done. Run ${BOLD}./run.sh${RESET} to build and start, or ${BOLD}./run.sh dev${RESET} for hot reload."
    ;;
  build)
    install_deps
    dequarantine_macos
    build_ui
    ok "Done. Run ${BOLD}./run.sh --skip-install${RESET} to start the server."
    ;;
  dev)
    install_deps
    dequarantine_macos
    run_dev
    ;;
  prod)
    install_deps
    dequarantine_macos
    build_ui
    run_prod
    ;;
esac
