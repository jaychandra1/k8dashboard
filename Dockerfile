# syntax=docker/dockerfile:1

# ------------------------------------------------------------------
# Pinned inputs. Bump deliberately (Dependabot tracks the base image;
# scripts/fetch-trivy.mjs and trivy-scan.js share TRIVY_VERSION with this
# file; run.sh shares KUBECTL_VERSION).
# ------------------------------------------------------------------
# node:22-alpine — multi-arch index digest resolved 2026-09-21.
ARG NODE_IMAGE=node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
# golang:1.26.10-alpine — multi-arch index digest resolved 2026-11-07. Only
# the kubelogin build stage uses it; nothing from it reaches the runtime image
# except the compiled binary.
ARG GO_IMAGE=golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696
ARG KUBECTL_VERSION=v1.37.2
ARG KUBELOGIN_VERSION=v1.36.4
# Modules raised above what kubelogin ${KUBELOGIN_VERSION} pins, to their
# fixed versions (go-jose: CVE-2026-116587; x/net: CVE-2026-78661,
# CVE-2026-78669). Drop this, and go back to the release binary, once a
# kubelogin release ships them.
ARG KUBELOGIN_MODULE_FIXES="github.com/go-jose/go-jose/v4@v4.1.6 golang.org/x/net@v0.62.0"
ARG TRIVY_VERSION=0.76.2

# ============================================================
# Stage 1 — build the React/Vite frontend
# ============================================================
# The output is static files, identical for every architecture, so this
# stage always runs on the build machine's own platform — a multi-arch build
# never runs npm/Vite under QEMU emulation, where Node can crash (SIGILL).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --ignore-scripts
COPY client/ ./
RUN npm run build

# ============================================================
# Stage 2 — install production backend dependencies
# ============================================================
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /app
# node-pty (pod terminal) has no Alpine/musl prebuild, so it compiles from
# source here — needs python3 + a C/C++ toolchain. This stage is discarded;
# only the resulting node_modules is copied into the runtime image.
#
# --ignore-scripts keeps every package's install hooks from running (supply
# chain hygiene); node-pty is then rebuilt explicitly, on its own.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild node-pty --foreground-scripts

# ============================================================
# Stage 3 — CLI tools, downloaded from pinned releases and checksum-verified
# ============================================================
FROM ${NODE_IMAGE} AS tools
ARG TARGETARCH
ARG KUBECTL_VERSION
ARG TRIVY_VERSION
RUN apk add --no-cache curl ca-certificates
WORKDIR /tools
# kubectl — dl.k8s.io publishes a .sha256 next to every binary.
RUN set -eu; \
  curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o kubectl; \
  curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" -o kubectl.sha256; \
  echo "$(cat kubectl.sha256)  kubectl" | sha256sum -c -; \
  chmod 0755 kubectl
# trivy — from the pinned GitHub release tarball, verified against the
# release's checksums file. No `curl | sh`.
RUN set -eu; \
  case "${TARGETARCH}" in amd64) tarch="64bit" ;; arm64) tarch="ARM64" ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac; \
  base="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}"; \
  asset="trivy_${TRIVY_VERSION}_Linux-${tarch}.tar.gz"; \
  curl -fsSL --retry 3 "${base}/${asset}" -o "${asset}"; \
  curl -fsSL --retry 3 "${base}/trivy_${TRIVY_VERSION}_checksums.txt" -o checksums.txt; \
  grep " ${asset}\$" checksums.txt | sha256sum -c -; \
  tar -xzf "${asset}" trivy; chmod 0755 trivy; rm "${asset}" checksums.txt

# ============================================================
# Stage 3b — kubelogin, built from its tagged source
# ============================================================
# Installed as kubectl-oidc_login so `kubectl oidc-login` exec plugins work.
# The release binary was built with an older Go and older modules that have
# fixed HIGH vulnerabilities, so it is compiled here from the same tag with a
# patched Go (GO_IMAGE) and KUBELOGIN_MODULE_FIXES applied. The source and
# every module come from the Go module proxy and are verified against the Go
# checksum database (sum.golang.org); GOTOOLCHAIN=local never fetches another
# Go. Pure Go, so it cross-compiles on the build machine (no QEMU).
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS kubelogin-build
ARG TARGETARCH
ARG KUBELOGIN_VERSION
ARG KUBELOGIN_MODULE_FIXES
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
RUN set -eu; \
  go mod download "github.com/int128/kubelogin@${KUBELOGIN_VERSION}"; \
  cp -R "$(go env GOMODCACHE)/github.com/int128/kubelogin@${KUBELOGIN_VERSION}/." /src; \
  chmod -R u+w /src; \
  go get ${KUBELOGIN_MODULE_FIXES}; \
  go mod tidy; \
  GOOS=linux GOARCH="${TARGETARCH}" go build -trimpath \
    -ldflags "-s -w -X main.version=${KUBELOGIN_VERSION}" -o /out/kubectl-oidc_login .; \
  go version -m /out/kubectl-oidc_login | grep -E 'go1|go-jose|golang.org/x/net' || true

# ============================================================
# Stage 4 — runtime image
# ============================================================
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Patch OS packages. bash is used by the in-pod shell fallback; libstdc++ by
# the node-pty addon.
# This line never changes, so a builder would reuse its cached layer and keep
# old packages. CI and release builds skip the cache for this stage
# (`no-cache-filters: runtime`); locally, build with
# `docker build --no-cache-filter runtime`.
# NOTE: helm is intentionally NOT installed — Helm releases are read directly
# via the Kubernetes API (see server.js), which also avoids the large cluster
# of Go-module CVEs that ship inside the helm binary.
RUN apk upgrade --no-cache \
  && apk add --no-cache bash ca-certificates libstdc++ \
  # npm/npx/corepack aren't used at runtime (the app runs `node server.js`);
  # removing them drops the CVEs in npm's bundled dependencies.
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

COPY --from=tools /tools/kubectl /tools/trivy /usr/local/bin/
COPY --from=kubelogin-build /out/kubectl-oidc_login /usr/local/bin/

# Backend deps + source, and the built frontend. Every module server.js
# imports must be here (see the import list at the top of server.js).
COPY --from=server-deps /app/node_modules ./node_modules
COPY package.json package-lock.json VERSION ./
# demo.js is imported by server.js but inert unless K8BOARD_DEMO=1 (test fixture).
COPY server.js assistant.js mcp.js mcp-stdio.js aws-eks.js eks-token.js azure-aks.js azure-token.js gcp-gke.js gke-token.js trivy-scan.js demo.js ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY --from=client-build /app/client/dist ./client/dist

# The server binds 127.0.0.1 by default (so a local install isn't exposed to the
# LAN). Inside a container it must bind all interfaces for the published port to
# work, so HOST is set here. Every request to /api, /mcp and /ws/exec still
# requires the bearer token: pass one with `-e K8BOARD_TOKEN=…`, or let the app
# generate one — it is printed at boot, so `docker logs <container>` shows the
# login URL. Prefer publishing to loopback on the host as well:
#   docker run -p 127.0.0.1:8080:3001 …
# When reaching the container through another hostname (a reverse proxy),
# allow it with `-e ALLOWED_HOSTS=k8board.internal` or requests get HTTP 421.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1

# ------------------------------------------------------------------
# OCI image metadata. The version label default below is kept equal to the
# VERSION file by scripts/sync-version.mjs (the release workflow also passes
# it explicitly as --build-arg APP_VERSION). At runtime the server reads the
# copied VERSION file itself, so the label is metadata only.
# GHCR shows `description` as the package's short blurb and, via `source`,
# links the package to its GitHub repo. docker/metadata-action overrides
# source/revision/created automatically.
# ------------------------------------------------------------------
ARG APP_VERSION="1.8.6"
LABEL org.opencontainers.image.title="K8Board" \
      org.opencontainers.image.description="Browse and operate Kubernetes clusters — workloads, nodes, events, logs, in-browser exec/terminal, service port-forwarding, Helm releases, RBAC and CRDs. Reads your kubeconfig and serves the UI + token-protected REST API on port 3001." \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/jaychandra1/K8Board" \
      org.opencontainers.image.licenses="MIT"

# Drop root — run as the unprivileged `node` user shipped in the base image.
# Its home (/home/node) is writable, so the default kubeconfig path becomes
# /home/node/.kube/config and the app's config (incl. the generated token)
# lands in /home/node/.config/kubepilot.
#
# HOME is set explicitly because Docker does NOT derive it from USER — without
# this it can be unset for the `node` user, so the app wouldn't know where to
# look for the kubeconfig. KUBECONFIG pins the default lookup to the documented
# mount point (`-v $HOME/.kube:/home/node/.kube`); a runtime `-e KUBECONFIG=…`
# still overrides it.
ENV HOME=/home/node \
    KUBECONFIG=/home/node/.kube/config
USER node

CMD ["node", "server.js"]
