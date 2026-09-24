import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { execFile } from 'child_process';
import http from 'http';
import zlib from 'zlib';
import { WebSocketServer } from 'ws';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import * as azure from './azure-aks.js';
import compression from 'compression';
import { registerAssistant } from './assistant.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { createMcpServer } from './mcp.js';
import * as awsEks from './aws-eks.js';
import * as trivyScan from './trivy-scan.js';
import * as demo from './demo.js';
import { ensurePtyHelperExecutable } from './lib/pty-helper.mjs';
import { logger as log, requestLogger } from './lib/logger.mjs';
import { HttpError, badRequest, conflict, sendError, apiNotFound, errorMiddleware } from './lib/http-errors.mjs';
import {
  isDnsLabel, isDnsSubdomain, isNamespace, isKind, isGroup, isVersion, isPlural,
  isContainer, isResourceName, isLabelValue, isPort, isContextName, isIntInRange, isPortForwardId,
  isMcpSessionId, isUuid, isAzureName, firstInvalid,
} from './lib/validate.mjs';
import { createCache } from './lib/cache.mjs';
import {
  getAuthToken, authMiddleware, verifyWsAuth, isAllowedHost, isAllowedOrigin, hostGuard, originGuard, pathCaseGuard,
} from './lib/auth.mjs';
import { CONFIG_DIR, DEMO_ENABLED, configFile, findConfigFile, isMcpSource, execEntry } from './lib/paths.mjs';
import { repairExecEntries } from './lib/kubeconfig-repair.mjs';
import {
  createKubectl, positional, spawnBin, collectChild, commandExists, resolveBinSync, loginShellPath,
  hasKubectl, kubectlMissingError, isSpawnMissing, KUBECTL_REQUIRED_MESSAGE,
} from './lib/kubectl.mjs';
import {
  restMappingFor, restartPatch, restartTarget, scaleTarget, scalePatch, argoSyncPatch, argoRefreshPatch,
  dropFinalizersPatch, parseApplyDocuments, requestOptions, patchOptions, PatchStrategy, applyDocuments,
  deleteResource, execInPod, resourceLabel,
} from './lib/k8s-ops.mjs';

// node-pty powers the pod terminal (a real PTY bridged to `kubectl exec`). Load
// it defensively so a missing/unbuildable native module never crashes the whole
// server — only the terminal feature is disabled in that (rare) case.
let pty = null;
try {
  // Restore node-pty's spawn-helper execute bit BEFORE first use, so pod
  // terminals don't fail with "posix_spawnp failed". See lib/pty-helper.mjs.
  ensurePtyHelperExecutable({ currentOnly: true });
  pty = (await import('node-pty')).default;
} catch (e) {
  log.warn('node-pty is unavailable; pod shells are disabled', { err: e });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Backend port. In dev, Vite (3000) proxies /api and /ws here; in the Docker
// image this same server also serves the built UI. Map it at runtime with
// `docker run -p <host>:3001`.
const PORT = Number(process.env.PORT) || 3001;
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');

let currentContext = null;
let kubeConfig = null;

// Response cache (lib/cache.mjs): LRU, bounded, keys prefixed with the current
// context, and writes dropped when the context changed mid-fetch.
const cache = createCache({ getContext: () => currentContext });
const CACHE_TTL = {
  resources: 30000, // 30 seconds
  events: 15000,    // 15 seconds
  namespaces: 60000, // 60 seconds
  yaml: 60000,       // 60 seconds
  logs: 2000,        // 2 seconds — just enough to absorb a double-poll
};
// Compute the key at the START of a handler (before any await) so it carries
// the context the fetch was made for.
const getCacheKey = (prefix, params) => cache.key(prefix, params);
const setCache = (key, value, ttl) => cache.set(key, value, ttl);
const getCache = (key) => cache.get(key);

// kubectl runner bound to the in-memory context (lib/kubectl.mjs). kubectl is
// only needed for the interactive pod terminal, service port-forward, the
// one-shot exec when it happens to be installed, and deleting a kind whose
// REST mapping cannot be resolved; everything else is the Kubernetes API. The
// on-disk kubeconfig does NOT reflect the in-memory context switch, so every
// spawn is pinned with --context; user-supplied names go through positional()
// (after `--`) and flag values use the --flag=value form.
const { runKubectl, execKubectl, spawnKubectl } = createKubectl({ getContext: () => currentContext });

// 400 { error, code: 'invalid_param', field } for the first failing check.
const bad = (res, field, message) =>
  res.status(400).json({ error: message || `Invalid ${field}`, code: 'invalid_param', field });
const checkParams = (res, pairs) => {
  const field = firstInvalid(pairs);
  if (field) { bad(res, field); return false; }
  return true;
};
const fail = (res, error, extra, fallback) => sendError(res, error, extra, fallback);

// Child processes we own outside kubectl one-shots (az login/az CLI calls,
// port-forwards, PTYs are tracked separately) — killed on shutdown.
const trackedChildren = new Set();
const trackChild = (child) => {
  if (!child || typeof child.on !== 'function') return child;
  trackedChildren.add(child);
  child.once('exit', () => trackedChildren.delete(child));
  child.once('error', () => trackedChildren.delete(child));
  return child;
};

// ------------------------------------------------------------------
// Middleware stack (order matters):
//   headers → host allowlist → path-case guard → compression → request log
//   → rate limit → origin guard → bearer auth → JSON body
// ------------------------------------------------------------------
app.disable('x-powered-by');
app.set('case sensitive routing', true);
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const p = req.path.toLowerCase();
  if (p.startsWith('/api') || p.startsWith('/mcp')) res.setHeader('Cache-Control', 'no-store');
  else res.setHeader('Content-Security-Policy', CSP); // HTML / static: the UI document
  next();
});

// Host allowlist on EVERY request (static + API + WS) — kills DNS rebinding.
app.use(hostGuard);
// /API/… or /Mcp/… → 404: the reserved prefixes must be exactly lowercase so no
// case variant can slip past a prefix-based guard.
app.use(pathCaseGuard);

app.use(compression());
app.use(requestLogger(log));

// Rate-limit the API/MCP surface (also bounds token guessing). Sits before auth.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_MAX) || 1000, // requests/min/IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'rate_limited' },
});
app.use(['/api', '/mcp'], apiLimiter);

// Origin guard for the API/MCP surface (mounted so it matches like the
// router). Requests WITHOUT an Origin are allowed only because the bearer
// token below is also required — see lib/auth.mjs for the full rule.
app.use(['/api', '/mcp'], originGuard);

// Bearer-token auth (Jupyter-style). Exempt: GET /healthz, GET /api/version.
app.use(authMiddleware);

app.use(express.json({ limit: '4mb' }));

// Liveness (unauthenticated).
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: getAppVersion(), uptime: Math.round(process.uptime()) });
});

// Route-param validation — runs for every route that names the param, before
// the handler, so nothing unvalidated reaches kubectl argv or the K8s API.
const paramRule = (name, pred) => app.param(name, (req, res, next, value) => (pred(value) ? next() : bad(res, name)));
paramRule('namespace', isNamespace);
paramRule('kind', isKind);
paramRule('name', isResourceName);
paramRule('pod', isDnsSubdomain);
paramRule('group', isGroup);
paramRule('version', isVersion);
paramRule('plural', isPlural);
paramRule('id', isPortForwardId);

// Path-segment validation that runs BEFORE the demo interception below (which
// answers data routes without ever reaching the app.param rules). Each entry
// lists, per segment after the route key, the field name and its predicate;
// a literal string must match exactly. Shorter paths validate their prefix.
const seg = (field, pred) => [field, pred];
const lit = (s) => [s, (v) => v === s];
const PATH_RULES = {
  resources: [seg('namespace', isNamespace)],
  resource: [seg('namespace', isNamespace), seg('kind', isKind), seg('name', isResourceName)],
  yaml: [seg('namespace', isNamespace), seg('kind', isKind), seg('name', isResourceName)],
  scale: [seg('namespace', isNamespace), seg('kind', isKind), seg('name', isResourceName)],
  restart: [seg('namespace', isNamespace), seg('kind', isKind), seg('name', isResourceName)],
  logs: [seg('namespace', isDnsLabel), seg('pod', isDnsSubdomain)],
  topology: [seg('namespace', isDnsLabel)],
  events: [seg('namespace', isNamespace)],
  nodes: [seg('name', isResourceName), lit('pods')],
  portforward: [seg('id', isPortForwardId)],
  customresources: [seg('group', isGroup), seg('version', isVersion), seg('plural', isPlural)],
  customresource: [seg('group', isGroup), seg('version', isVersion), seg('plural', isPlural), seg('name', isResourceName)],
  helm: [lit('releases'), seg('namespace', isDnsLabel), seg('name', isResourceName), seg('action', (v) => v === 'values' || v === 'manifest')],
  argocd: [seg('resource', (v) => /^[a-z]+$/.test(v)), seg('namespace', isDnsLabel), seg('name', isResourceName), seg('action', (v) => v === 'sync' || v === 'refresh')],
  metrics: [seg('scope', (v) => v === 'pods' || v === 'pod' || v === 'node'), seg('namespace', isNamespace), seg('pod', isDnsSubdomain)],
};
app.use('/api', (req, res, next) => {
  const parts = req.path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ' '; } });
  const rules = PATH_RULES[parts[0]];
  if (!rules) return next();
  for (let i = 0; i < rules.length && i + 1 < parts.length; i++) {
    const [field, pred] = rules[i];
    if (!pred(parts[i + 1])) return bad(res, field);
  }
  // Query bounds that must hold in demo mode too (demo.js answers before the
  // real handlers run).
  if (parts[0] === 'logs') {
    if (req.query.tail !== undefined && !isIntInRange(req.query.tail, 1, 20000)) return bad(res, 'tail', 'tail must be an integer between 1 and 20000');
    if (req.query.container !== undefined && !isContainer(String(req.query.container))) return bad(res, 'container');
  }
  next();
});

// MCP write gate: mcp.js calls this REST API with `X-KubePilot-Source: mcp`;
// when the UI toggle is off, every mutating route refuses those calls.
const mcpWriteGate = (req, res, next) => {
  if (isMcpSource(req) && !mcpAllowWrite) {
    return res.status(403).json({ error: 'MCP write access is disabled', code: 'mcp_write_disabled' });
  }
  next();
};

// ------------------------------------------------------------------
// Demo mode (test/dev fixture, KUBEPILOT_DEMO=1 only) — when the flag is set
// and the active context is the synthetic 'demo-cluster', serve an in-memory
// cluster (demo.js). This single interception covers all data + mutation
// endpoints; config/cloud/MCP/static fall through, and the assistant is
// handled explicitly (canned, no LLM needed). With the flag unset every demo
// touchpoint below is a no-op and 'demo-cluster' is just an ordinary (and
// most likely unknown) context name.
// ------------------------------------------------------------------
const demoActive = () => DEMO_ENABLED && demo.isDemo(currentContext);
app.use((req, res, next) => {
  if (!demoActive()) return next();
  const p = req.path;
  // Real config handlers stay in charge (they are demo-aware).
  if (p === '/api/config/status' || p === '/api/config/context' ||
      p === '/api/config/load' || p === '/api/config/reload' || p === '/api/config/capabilities') return next();
  // Auth always "passes" in demo.
  if (p === '/api/config/auth') return res.json({ ok: true, currentContext: demo.DEMO_CONTEXT });
  // Assistant: report enabled + stream canned answers (no LLM required).
  if (p === '/api/assistant/status') {
    return res.json({ enabled: true, source: 'demo', editable: false, baseUrl: '', model: 'kubepilot-demo (canned)' });
  }
  if (p === '/api/assistant/chat' && req.method === 'POST') return demoAssistantChat(req, res);
  // Cloud sign-in, agent detection, MCP, version and non-API paths are unchanged.
  if (p.startsWith('/api/azure') || p.startsWith('/api/aws') ||
      p.startsWith('/api/ai-agents') || p === '/mcp' || p === '/api/version' ||
      !p.startsWith('/api/')) return next();
  // The MCP write gate applies to (pretend) mutations in demo mode too.
  if (req.method !== 'GET' && isMcpSource(req) && !mcpAllowWrite) {
    return res.status(403).json({ error: 'MCP write access is disabled', code: 'mcp_write_disabled' });
  }
  // Everything else under /api (incl. POST /api/exec) is cluster data → the
  // synthetic cluster. Anything demo.js declines must never reach a real
  // kubectl while in demo mode, so answer it here instead of falling through.
  if (demo.handle(req, res)) return;
  if (p === '/api/exec') return res.json({ output: '(demo) command executed', code: 0 });
  return next();
});

// Canned, streamed assistant reply for demo mode — matches the SSE event
// shape of /api/assistant/chat (token / tool / done).
function demoAssistantChat(req, res) {
  const history = req.body?.messages;
  if (!Array.isArray(history)) return bad(res, 'messages', 'messages must be an array');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); res.flush?.(); };
  const last = [...history].reverse().find((m) => m && m.role === 'user');
  const { text, toolCalls } = demo.aiReply(last?.text || '');
  (toolCalls || []).forEach((name) => send('tool', { name, input: {} }));
  const words = String(text).split(/(\s+)/);
  let i = 0;
  const tick = () => {
    if (res.writableEnded) return;
    if (i >= words.length) { send('done', {}); return res.end(); }
    send('token', { text: words[i++] });
    setTimeout(tick, 18);
  };
  // Stop streaming if the client actually disconnects (res 'close', not req —
  // req 'close' fires as soon as the small POST body is read).
  res.on('close', () => { i = words.length; });
  setTimeout(tick, (toolCalls && toolCalls.length) ? 250 : 0);
}

// Serve the built frontend in production (when client/dist exists)
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}

// ------------------------------------------------------------------
// Kubeconfig loading.
//   • KUBECONFIG may list several files (path.delimiter-separated): reads merge
//     them all (loadFromDefault); writes go to the first existing one.
//   • POST /api/config/load pins an explicit file (activeKubeconfigPath);
//     reload / import then operate on that file.
//   • A load only replaces the live KubeConfig on success — a broken file
//     never leaves the app without a cluster.
// ------------------------------------------------------------------
let activeKubeconfigPath = null; // set only by POST /api/config/load

const kubeconfigEnvPaths = () =>
  String(process.env.KUBECONFIG || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
const defaultKubeconfigPath = () => {
  // HOME may be unset for a non-root container user; fall back to os.homedir().
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.kube', 'config');
};
// The file kubeconfig WRITES (imports) go to, and the path shown in the UI.
const getKubeConfigPath = () => {
  if (activeKubeconfigPath) return activeKubeconfigPath;
  const envPaths = kubeconfigEnvPaths();
  if (envPaths.length) return envPaths.find((p) => fs.existsSync(p)) || envPaths[0];
  return defaultKubeconfigPath();
};

// Parse a kubeconfig into a fresh KubeConfig (never the live one). Throws on
// parse failure or when it defines no context.
const parseKubeConfig = ({ filePath } = {}) => {
  const kc = new k8s.KubeConfig();
  if (filePath) kc.loadFromFile(filePath);
  else kc.loadFromDefault(); // honours a multi-path KUBECONFIG
  if (!Array.isArray(kc.contexts) || kc.contexts.length === 0) throw new Error('kubeconfig defines no contexts');
  if (!kc.getCurrentContext() || !kc.contexts.some((c) => c.name === kc.getCurrentContext())) {
    kc.setCurrentContext(kc.contexts[0].name);
  }
  return kc;
};

const warnDemoCollision = (kc) => {
  if (DEMO_ENABLED && kc.contexts.some((c) => c.name === demo.DEMO_CONTEXT)) {
    log.warn('a real kubeconfig context is named like the built-in demo cluster; demo mode is disabled while it exists', { context: demo.DEMO_CONTEXT });
  }
};

// Before a file is parsed, rewrite any of *our* stale exec entries in it
// (e.g. the pre-fuse `ELECTRON_RUN_AS_NODE` form, or a moved/renamed app
// binary) — see lib/kubeconfig-repair.mjs. Never throws.
const repairKubeconfigFiles = (filePath) => {
  const files = filePath ? [filePath] : kubeconfigEnvPaths();
  let repaired = 0;
  for (const p of files) {
    if (fs.existsSync(p)) repaired += repairExecEntries(p).repaired.length;
  }
  return repaired;
};

// Load `filePath` (or the KUBECONFIG/default set when omitted) and swap it in
// only on success. Returns true/false; never throws.
const loadKubeConfig = (filePath) => {
  try {
    repairKubeconfigFiles(filePath);
    const kc = parseKubeConfig({ filePath });
    kubeConfig = kc;
    currentContext = kc.getCurrentContext();
    warnDemoCollision(kc);
    return true;
  } catch (error) {
    log.error('failed to load kubeconfig', { path: filePath || '(KUBECONFIG)', err: error });
    return false;
  }
};

// Re-read whatever is the active source: the explicitly loaded file, else the
// KUBECONFIG set, else ~/.kube/config.
const reloadKubeConfig = () => {
  if (activeKubeconfigPath) return loadKubeConfig(activeKubeconfigPath);
  if (kubeconfigEnvPaths().length) return loadKubeConfig(undefined);
  const p = defaultKubeconfigPath();
  return fs.existsSync(p) ? loadKubeConfig(p) : false;
};

// Reload after an import, keeping the user on the context they were using.
const reloadPreservingContext = () => {
  const prev = currentContext;
  reloadKubeConfig();
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) {
    kubeConfig.setCurrentContext(prev);
    currentContext = prev;
  }
  cache.clear();
};

// Initialize with the default kubeconfig source.
if (kubeconfigEnvPaths().length) {
  if (kubeconfigEnvPaths().some((p) => fs.existsSync(p))) loadKubeConfig(undefined);
} else if (fs.existsSync(defaultKubeconfigPath())) {
  loadKubeConfig(defaultKubeconfigPath());
}

// API Endpoints

// App version — single source of truth is the repo VERSION file; falls back to
// package.json (VERSION isn't shipped in the Docker image, but package.json is
// and is kept in sync by scripts/sync-version.mjs).
let APP_VERSION = null;
const getAppVersion = () => {
  if (APP_VERSION) return APP_VERSION;
  try {
    APP_VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
  } catch {
    try {
      APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    } catch {
      APP_VERSION = 'unknown';
    }
  }
  return APP_VERSION;
};

app.get('/api/version', (req, res) => {
  res.json({ version: getAppVersion() });
});

// Persisted app settings (small JSON in the user config dir). Used so the
// desktop app can toggle MCP write tools from the UI instead of an env var.
const SETTINGS_FILE = findConfigFile('settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    const dest = configFile('settings.json');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (e) { /* best-effort */ }
  return next;
}
// MCP write tools: the persisted UI toggle wins; MCP_ALLOW_WRITE is the initial
// default when nothing has been set yet.
let mcpAllowWrite = (() => {
  const s = readSettings();
  if (typeof s.mcpAllowWrite === 'boolean') return s.mcpAllowWrite;
  return ['1', 'true', 'yes'].includes(String(process.env.MCP_ALLOW_WRITE || '').toLowerCase());
})();

// MCP connection info for the Preferences → MCP section. The HTTP endpoint is
// this same server at /mcp; write tools are gated by `mcpAllowWrite`.
app.get('/api/mcp/info', (req, res) => {
  const httpUrl = `http://127.0.0.1:${PORT}/mcp`;
  res.json({
    allowWrite: mcpAllowWrite,
    token: getAuthToken(),
    httpUrl,
    stdioEnv: { MCP_API_BASE: `http://127.0.0.1:${PORT}`, MCP_API_TOKEN: getAuthToken() },
    readTools: [
      'list_contexts', 'switch_context', 'list_namespaces', 'list_resources',
      'get_resource', 'get_resource_yaml', 'get_pod_logs', 'get_events', 'get_topology',
      'get_cluster_summary', 'list_nodes', 'get_node_pods', 'get_node_metrics',
      'get_pod_metrics', 'list_pod_metrics', 'list_storage', 'get_rbac',
      'list_helm_releases', 'get_helm_values', 'get_helm_manifest',
      'list_crds', 'list_custom_resources', 'get_custom_resource',
      'get_argocd_status', 'list_argocd_apps', 'get_argocd_app',
      'list_argocd_projects', 'list_argocd_appsets', 'list_argocd_repositories', 'list_argocd_clusters',
    ],
    writeTools: [
      'apply_yaml', 'delete_resource', 'scale_workload', 'rollout_restart',
      'sync_argocd_app', 'refresh_argocd_app',
    ],
  });
});

// Toggle MCP write tools from the UI (persisted). Takes effect for new MCP
// sessions — a connected agent must reconnect to pick up the new tool set.
app.post('/api/mcp/config', (req, res) => {
  const { allowWrite } = req.body || {};
  if (typeof allowWrite !== 'boolean') {
    return res.status(400).json({ error: 'allowWrite (boolean) is required' });
  }
  mcpAllowWrite = allowWrite;
  writeSettings({ mcpAllowWrite: allowWrite });
  res.json({ allowWrite: mcpAllowWrite });
});

app.get('/api/config/status', (req, res) => {
  // Tag each context with its cloud provider (derived from the cluster's server
  // URL) so the UI can group and icon them.
  const providerOf = (server = '') => {
    const s = server.toLowerCase();
    if (s.includes('.azmk8s.io') || s.includes('azure')) return 'azure';
    if (s.includes('.eks.amazonaws.com') || s.includes('eks.') ) return 'aws';
    if (s.includes('.gke.') || s.includes('container.googleapis.com')) return 'gcp';
    if (/(127\.0\.0\.1|localhost|:6443|:8443|host\.docker|kubernetes\.docker|minikube|kind|orbstack|rancher)/.test(s)) return 'local';
    return 'other';
  };

  let contexts = [], contextsInfo = [], clusters = [];
  if (kubeConfig) {
    const clusterByName = new Map(kubeConfig.clusters.map((c) => [c.name, c]));
    contextsInfo = kubeConfig.contexts.map((c) => {
      const cl = clusterByName.get(c.cluster);
      return { name: c.name, cluster: c.cluster, provider: providerOf(cl?.server) };
    });
    contexts = kubeConfig.contexts.map((c) => c.name);
    clusters = kubeConfig.clusters.map((c) => c.name);
  }

  // The synthetic demo cluster is offered (listed first) only when the
  // KUBEPILOT_DEMO test/dev flag is set; the product never shows it otherwise.
  if (DEMO_ENABLED) {
    const demoInfo = demo.demoContextInfo(); // { name, cluster, provider: 'demo' }
    contexts = [demoInfo.name, ...contexts];
    contextsInfo = [demoInfo, ...contextsInfo];
    clusters = [demoInfo.cluster, ...clusters];
  }

  const inDemo = demoActive();
  if (!kubeConfig && !inDemo) {
    const attemptedPath = getKubeConfigPath();
    return res.json({
      loaded: false,
      demoAvailable: DEMO_ENABLED,
      contexts,
      contextsInfo,
      defaultPath: attemptedPath,
      exists: fs.existsSync(attemptedPath),
    });
  }

  res.json({
    loaded: true,
    demoAvailable: DEMO_ENABLED,
    currentContext: inDemo ? demo.DEMO_CONTEXT : currentContext,
    path: inDemo ? 'demo (synthetic cluster)' : getKubeConfigPath(),
    contexts,
    contextsInfo,
    clusters,
  });
});

// Directories a kubeconfig may be loaded from: the user's home, plus any
// directory listed in KUBECONFIG_DIRS (path.delimiter-separated).
const isPathInside = (dir, file) => {
  const rel = path.relative(path.resolve(dir), file);
  const r = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};
const isAllowedKubeconfigPath = (file) => {
  const roots = [os.homedir(), ...String(process.env.KUBECONFIG_DIRS || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean)];
  return roots.some((root) => isPathInside(root, file));
};

app.post('/api/config/load', (req, res) => {
  const { filePath } = req.body || {};
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    return bad(res, 'filePath', 'filePath must be an absolute path');
  }
  const resolved = path.resolve(filePath);
  if (!isAllowedKubeconfigPath(resolved)) {
    return res.status(403).json({ error: 'Kubeconfig must live under your home directory (or a KUBECONFIG_DIRS entry)', code: 'forbidden', field: 'filePath' });
  }
  let st;
  try { st = fs.statSync(resolved); } catch { st = null; }
  if (!st || !st.isFile()) return res.status(400).json({ error: 'File not found', code: 'not_found', field: 'filePath' });

  let kc;
  try { kc = parseKubeConfig({ filePath: resolved }); }
  catch (e) { return res.status(400).json({ error: `Invalid kubeconfig: ${firstLine(e.message)}`, code: 'invalid_kubeconfig' }); }
  kubeConfig = kc;
  currentContext = kc.getCurrentContext();
  activeKubeconfigPath = resolved;
  warnDemoCollision(kc);
  cache.clear();
  res.json({ success: true, currentContext, contexts: kubeConfig.contexts.map((c) => c.name) });
});

// Current context (read). MCP's switch_context is write-gated on its side; the
// UI polls this to notice an external switch instead of being changed silently.
app.get('/api/config/context', (req, res) => {
  const inDemo = demoActive();
  const real = kubeConfig?.contexts.map((c) => c.name) || [];
  res.json({
    currentContext: inDemo ? demo.DEMO_CONTEXT : currentContext,
    contexts: DEMO_ENABLED ? [demo.DEMO_CONTEXT, ...real] : real,
  });
});

app.post('/api/config/context', (req, res) => {
  const { contextName } = req.body || {};
  if (!isContextName(contextName)) return bad(res, 'contextName');

  // KUBEPILOT_DEMO=1 only: enter the synthetic demo cluster (works with no
  // kubeconfig at all) — unless a real context shares its name, in which case
  // the real one must win and demo mode is refused rather than silently
  // aliasing two clusters. With the flag unset, 'demo-cluster' falls through
  // to the ordinary lookup below and is rejected like any unknown context.
  if (DEMO_ENABLED && demo.isDemo(contextName)) {
    if (kubeConfig?.contexts.some((c) => c.name === contextName)) {
      log.warn('refusing demo mode: a real context has the demo name', { context: contextName });
      return res.status(409).json({ error: `A real kubeconfig context is named "${contextName}"; the built-in demo cluster is unavailable while it exists.`, code: 'demo_name_collision' });
    }
    currentContext = demo.DEMO_CONTEXT;
    cache.clear();
    return res.json({ success: true, currentContext });
  }

  if (!kubeConfig) {
    return bad(res, 'contextName', 'Context not found: no kubeconfig loaded');
  }

  const context = kubeConfig.contexts.find(c => c.name === contextName);
  if (!context) {
    return bad(res, 'contextName', 'Context not found');
  }

  try {
    // Switch the active context in-memory. This avoids shelling out to kubectl
    // (which may be absent in a packaged app and permanently rewrites the user's
    // kubeconfig on disk). Every handler builds its API client fresh via
    // kubeConfig.makeApiClient(), so subsequent requests use the new context.
    kubeConfig.setCurrentContext(contextName);
    currentContext = kubeConfig.getCurrentContext();

    // Drop everything cached against the previous cluster so the UI doesn't show
    // stale data (namespaces, resources, storage, rbac, …) after the switch.
    cache.clear();

    res.json({ success: true, currentContext });
  } catch (error) {
    res.status(500).json({ error: `Failed to set context: ${error.message}` });
  }
});

// Reload the kubeconfig from disk, preserving the in-memory selected context.
// Building a fresh KubeConfig drops any cached exec-credential token, so after
// an external re-login (`az login`, `aws sso login`, or the in-app sign-in flow)
// the next auth check picks up the new token instead of reusing the stale one.
app.post('/api/config/reload', (req, res) => {
  const p = getKubeConfigPath();
  if (!fs.existsSync(p)) return res.status(400).json({ error: 'No kubeconfig found' });
  const prev = currentContext;
  if (!reloadKubeConfig()) return res.status(500).json({ error: 'Failed to reload kubeconfig', code: 'invalid_kubeconfig' });
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) {
    kubeConfig.setCurrentContext(prev);
    currentContext = prev;
  }
  cache.clear();
  res.json({ success: true, currentContext });
});

// What this install can do without kubectl. Every read and simple mutation
// uses the Kubernetes API; only the interactive pod terminal and service
// port-forward need the kubectl binary. Cached 60 s; `?refresh=1` re-probes
// (e.g. right after the user installs kubectl).
app.get('/api/config/capabilities', async (req, res) => {
  const kubectl = await hasKubectl({ refresh: req.query.refresh === '1' || req.query.refresh === 'true' });
  res.json({
    kubectl,
    terminal: kubectl.available && !!pty,
    portForward: kubectl.available,
  });
});

// ------------------------------------------------------------------
// Azure AKS integration — two sign-in methods.
//
//  1) 'browser' (default, CLI-free): OAuth auth-code + PKCE in the system
//     browser (see azure-aks.js) + the ARM REST API. The browser carries the
//     device's compliance state, so it satisfies managed-device Conditional
//     Access policies (device-code cannot).
//  2) 'az': the classic Azure CLI flow (`az login` / `az aks …`), used when the
//     user prefers it or the browser flow is blocked. Only offered if `az` is
//     on PATH.
// ------------------------------------------------------------------
const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';

// az CLI helpers (method 'az').
const runAz = async (args, timeout = 60000) => {
  const child = spawnBin('az', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  trackChild(child);
  const r = await collectChild(child, { timeoutMs: timeout, maxBuffer: 64 * 1024 * 1024, label: 'az' });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `az exited ${r.code}`).trim());
  return r.stdout;
};
const azJson = async (args, timeout) => JSON.parse(await runAz([...args, '-o', 'json'], timeout));

let azureMethod = 'browser';  // active sign-in method
let azLogin = null;           // az login session: { proc, status, method, userCode, verificationUrl, error, buffer }

app.get('/api/azure/status', async (req, res) => {
  const azInstalled = await commandExists('az');
  const loggedIn = azure.isLoggedIn() || (azureMethod === 'az' && azLogin?.status === 'done');
  const account = azure.isLoggedIn() ? azure.loginStatus().account : undefined;
  res.json({ installed: true, azInstalled, loggedIn, method: azureMethod, account: account ? { name: account } : undefined });
});

app.post('/api/azure/login', async (req, res) => {
  const method = req.body?.method === 'az' ? 'az' : 'browser';
  const tenant = (req.body?.tenant || 'organizations').toString();
  azureMethod = method;

  if (method === 'browser') {
    try {
      const { authUrl } = await azure.startBrowserLogin(tenant);
      res.json({ method: 'browser', status: 'pending', authUrl });
    } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
    return;
  }

  // az method — spawn `az login` (browser by default; device-code on request).
  if (!(await commandExists('az'))) return res.status(400).json({ error: 'Azure CLI (az) is not installed or not on PATH.' });
  const useDeviceCode = req.body?.deviceCode === true;
  let proc;
  try { proc = spawnBin('az', ['login', '--only-show-errors', ...(useDeviceCode ? ['--use-device-code'] : [])], { env: process.env }); trackChild(proc); }
  catch (e) { return res.status(500).json({ error: `Failed to launch az login: ${e.message}` }); }
  const session = { proc, status: 'pending', method: useDeviceCode ? 'device' : 'browser', userCode: null, verificationUrl: 'https://microsoft.com/devicelogin', error: null, buffer: '' };
  azLogin = session;
  let replied = false;
  const reply = () => { if (replied || res.headersSent) return; replied = true; res.json({ method: 'az', submethod: session.method, status: session.status, userCode: session.userCode, verificationUrl: session.verificationUrl, error: session.error }); };
  const onData = (buf) => {
    session.buffer += buf.toString();
    const code = session.buffer.match(/enter the code\s+([A-Z0-9]{6,})/i);
    const url = session.buffer.match(/(https?:\/\/\S*devicelogin\S*)/i);
    if (code) { session.userCode = code[1]; session.method = 'device'; }
    if (url) session.verificationUrl = url[1].replace(/[.,)]+$/, '');
    if (session.userCode) reply();
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (codeNum) => { session.status = codeNum === 0 ? 'done' : 'error'; if (codeNum !== 0 && !session.error) session.error = firstLine(session.buffer) || `az login exited (${codeNum})`; reply(); });
  proc.on('error', (e) => { session.status = 'error'; session.error = e.message; reply(); });
  setTimeout(reply, 1500);
});

app.get('/api/azure/login/status', (req, res) => {
  if (azureMethod === 'az') {
    if (!azLogin) return res.json({ status: 'idle' });
    return res.json({ status: azLogin.status, method: 'az', submethod: azLogin.method, userCode: azLogin.userCode, verificationUrl: azLogin.verificationUrl, error: azLogin.error });
  }
  res.json(azure.loginStatus());
});

app.post('/api/azure/login/cancel', (req, res) => {
  try { azLogin?.proc?.kill(); } catch { /* ignore */ }
  azLogin = null;
  azure.cancelLogin();
  res.json({ ok: true });
});

app.get('/api/azure/clusters', async (req, res) => {
  try {
    let clusters, subscriptions;
    if (azureMethod === 'az') {
      const subs = await azJson(['account', 'list', '--all'], 30000);
      const enabled = subs.filter((s) => s.state === 'Enabled');
      const perSub = await Promise.all(enabled.map(async (s) => {
        try {
          const list = await azJson(['aks', 'list', '--subscription', s.id, '--only-show-errors'], 90000);
          return list.map((a) => ({
            name: a.name,
            resourceGroup: a.resourceGroup || a.nodeResourceGroup?.replace(/^MC_/, '').split('_')[0],
            subscriptionId: s.id, subscriptionName: s.name, location: a.location,
            kubernetesVersion: a.currentKubernetesVersion || a.kubernetesVersion,
            powerState: a.powerState?.code || a.provisioningState,
          }));
        } catch { return []; }
      }));
      clusters = perSub.flat().sort((a, b) => a.name.localeCompare(b.name));
      subscriptions = enabled.length;
    } else {
      if (!azure.isLoggedIn()) return res.status(401).json({ error: 'Not signed in to Azure' });
      ({ clusters, subscriptions } = await azure.listAllClusters());
    }
    const existing = new Set((kubeConfig?.contexts || []).map((c) => c.name));
    const existingClusters = new Set((kubeConfig?.clusters || []).map((c) => c.name));
    for (const c of clusters) c.imported = existing.has(c.name) || existingClusters.has(c.name);
    res.json({ clusters, subscriptions });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// Merge a fetched kubeconfig (YAML string) into an on-disk kubeconfig object,
// de-duplicating clusters/users/contexts by name.
// Rewrite an AAD cluster's kubeconfig user so it authenticates via our bundled
// azure-token.js (CLI-free) instead of the kubelogin exec that ARM/az returns.
// Cert-based users (non-AAD / --admin) have no exec and pass through untouched.
// The well-known AKS AAD server app id is used when the source omits --server-id.
const AKS_AAD_SERVER_ID = '6dae42f8-4368-4678-94ff-3960e28e3630';
function nativizeAksExec(kcYaml) {
  const kc = yaml.load(kcYaml) || {};
  for (const u of (kc.users || [])) {
    const exec = u?.user?.exec;
    if (!exec) continue; // cert-based user — already CLI-free
    const args = Array.isArray(exec.args) ? exec.args : [];
    const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const serverId = getArg('--server-id') || AKS_AAD_SERVER_ID;
    const tenant = getArg('--tenant-id') || getArg('--tenant') || azure.getTenant() || 'organizations';
    // Packaged app: `KubePilot --token-helper azure …`; source/Docker:
    // `node azure-token.js …` (lib/paths.mjs execEntry decides).
    const helper = execEntry('azure', ['--server-id', serverId, '--tenant', tenant]);
    u.user.exec = {
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: helper.command,
      args: helper.args,
      ...(helper.env ? { env: helper.env } : {}),
      interactiveMode: 'Never',
      provideClusterInfo: false,
    };
  }
  return yaml.dump(kc);
}

// Safe kubeconfig merge + write:
//   • an existing file that does not parse → 409 (never overwrite it),
//   • first write of the session → copy to <file>.kubepilot-backup-<timestamp>,
//   • write via a temp file + rename, mode 0600.
const backedUpKubeconfigs = new Set();
function mergeKubeconfigYaml(existingPath, incomingYaml) {
  let base = { apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [], 'current-context': '' };
  if (fs.existsSync(existingPath)) {
    let existing;
    try { existing = yaml.load(fs.readFileSync(existingPath, 'utf-8')); }
    catch (e) { throw conflict(`Existing kubeconfig at ${existingPath} could not be parsed (${firstLine(e.message)}); refusing to overwrite it`, 'kubeconfig_unparseable'); }
    if (existing !== null && existing !== undefined && (typeof existing !== 'object' || Array.isArray(existing))) {
      throw conflict(`Existing kubeconfig at ${existingPath} is not a YAML mapping; refusing to overwrite it`, 'kubeconfig_unparseable');
    }
    base = { ...base, ...(existing || {}) };
  }
  for (const k of ['clusters', 'users', 'contexts']) if (!Array.isArray(base[k])) base[k] = [];
  const incoming = yaml.load(incomingYaml) || {};
  const mergeBy = (list, add) => {
    for (const item of (add || [])) {
      const i = list.findIndex((x) => x.name === item.name);
      if (i >= 0) list[i] = item; else list.push(item);
    }
  };
  mergeBy(base.clusters, incoming.clusters);
  mergeBy(base.users, incoming.users);
  mergeBy(base.contexts, incoming.contexts);
  return base;
}

function writeKubeconfigAtomically(p, config) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  if (fs.existsSync(p) && !backedUpKubeconfigs.has(p)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(p, `${p}.kubepilot-backup-${stamp}`);
    backedUpKubeconfigs.add(p);
  }
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(config), { mode: 0o600 });
  try { fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
}

app.post('/api/azure/import', async (req, res) => {
  const { clusters = [], admin = false } = req.body || {};
  if (!Array.isArray(clusters) || clusters.length === 0 || clusters.length > 200) return res.status(400).json({ error: 'No clusters selected' });
  if (azureMethod === 'browser' && !azure.isLoggedIn()) return res.status(401).json({ error: 'Not signed in to Azure' });

  const p = getKubeConfigPath();
  const imported = [], failed = [];
  for (const c of clusters) {
    if (!isAzureName(c?.name) || !isAzureName(c?.resourceGroup) || !isUuid(c?.subscriptionId)) {
      failed.push({ name: typeof c?.name === 'string' ? c.name.slice(0, 90) : '?', error: 'Missing or invalid cluster identifiers' });
      continue;
    }
    try {
      if (azureMethod === 'az') {
        // `az aks get-credentials` writes/merges into the kubeconfig itself.
        const args = ['aks', 'get-credentials', `--resource-group=${c.resourceGroup}`, `--name=${c.name}`, `--subscription=${c.subscriptionId}`, '--overwrite-existing', '--only-show-errors'];
        if (admin) args.push('--admin');
        await runAz(args, 90000);
      } else {
        // Browser/REST: fetch the kubeconfig and merge it in ourselves. For AAD
        // clusters (non-admin), rewrite the kubelogin exec to our bundled
        // azure-token.js so the cluster needs neither `az` nor `kubelogin`.
        const raw = await azure.getClusterKubeconfig(c.subscriptionId, c.resourceGroup, c.name, admin);
        const kc = admin ? raw : nativizeAksExec(raw);
        const merged = mergeKubeconfigYaml(p, kc); // throws 409 if the existing file is unparseable
        writeKubeconfigAtomically(p, merged);       // persist incrementally
      }
      imported.push(c.name);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return res.status(409).json({ error: e.message, code: e.code, imported, failed });
      failed.push({ name: c.name, error: firstLine(e.message) });
    }
  }

  // Reload the kubeconfig so the new contexts appear immediately; keep the user
  // on the context they were already using instead of switching them away.
  reloadPreservingContext();
  res.json({ imported, failed, contexts: kubeConfig?.contexts.map((c) => c.name) || [], currentContext });
});

// ------------------------------------------------------------------
// AWS EKS one-click integration — CLI-FREE (AWS SDK for JavaScript v3).
//
// No `aws` binary: sign in (SSO device flow / access keys / assume-role),
// discover every EKS cluster across accounts and regions, and write kubeconfig
// entries whose auth execs our native eks-token.js helper. See aws-eks.js.
// ------------------------------------------------------------------
let awsSession = null; // { sso: { accessToken, ssoRegion, startUrl }, ssoClusters: Map, poll }

app.get('/api/aws/status', async (req, res) => {
  // The SDK is bundled, so the integration is always available — no CLI needed.
  try {
    const profiles = (await awsEks.listProfiles()).map((p) => p.name);
    res.json({ installed: true, profiles });
  } catch (e) { res.json({ installed: true, profiles: [] }); }
});

app.post('/api/aws/sso-login', async (req, res) => {
  try {
    const { profile, startUrl: bodyUrl, ssoRegion: bodyRegion } = req.body || {};
    // Accept pasted URLs with a "#/..." fragment or trailing slashes. Trim the
    // fragment and trailing slashes without a backtracking regex (ReDoS-safe).
    const clean = (u) => {
      let s = String(u || '').trim();
      const hash = s.indexOf('#');
      if (hash !== -1) s = s.slice(0, hash);
      let i = s.length;
      while (i > 0 && s[i - 1] === '/') i--;
      return s.slice(0, i);
    };
    let startUrl = clean(bodyUrl), ssoRegion = bodyRegion;
    if (!startUrl || !ssoRegion) {
      // Fall back to an existing SSO profile's start URL / region.
      const all = await awsEks.listProfiles();
      const p = all.find((x) => x.name === profile) || all.find((x) => x.type === 'sso');
      startUrl = startUrl || clean(p?.ssoStartUrl);
      ssoRegion = ssoRegion || p?.ssoRegion;
    }
    // Leave ssoRegion undefined so the SDK layer auto-detects the Identity Center
    // region from the start URL (cluster discovery still scans every region).
    if (!startUrl) return res.status(400).json({ error: 'Enter your AWS SSO start URL.' });
    const session = await awsEks.ssoStartDeviceFlow({ startUrl, ssoRegion: ssoRegion || undefined });
    awsSession = { sso: null, ssoClusters: new Map(), device: session, status: 'pending', error: null };
    res.json({ status: 'pending', userCode: session.userCode, verificationUrl: session.verificationUri });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.get('/api/aws/sso-login/status', async (req, res) => {
  if (!awsSession?.device) return res.json({ status: awsSession?.status || 'idle' });
  if (awsSession.status !== 'pending') return res.json({ status: awsSession.status, error: awsSession.error, userCode: awsSession.device.userCode, verificationUrl: awsSession.device.verificationUri });
  try {
    const out = await awsEks.ssoPollToken(awsSession.device);
    if (out.pending) return res.json({ status: 'pending', userCode: awsSession.device.userCode, verificationUrl: awsSession.device.verificationUri });
    awsSession.sso = { accessToken: out.accessToken, ssoRegion: awsSession.device.ssoRegion, startUrl: awsSession.device.startUrl };
    awsSession.status = 'done';
    res.json({ status: 'done' });
  } catch (e) { awsSession.status = 'error'; awsSession.error = firstLine(e.message); res.json({ status: 'error', error: awsSession.error }); }
});

app.post('/api/aws/sso-login/cancel', (req, res) => { awsSession = null; res.json({ ok: true }); });

// After SSO auth: choose an AWS account, then a role for it.
app.get('/api/aws/sso-accounts', async (req, res) => {
  if (!awsSession?.sso?.accessToken) return res.status(400).json({ error: 'Not signed in to AWS SSO' });
  try { res.json({ accounts: await awsEks.ssoListAccounts(awsSession.sso) }); }
  catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.get('/api/aws/sso-roles', async (req, res) => {
  if (!awsSession?.sso?.accessToken) return res.status(400).json({ error: 'Not signed in to AWS SSO' });
  const account = req.query.account;
  if (!account) return res.status(400).json({ error: 'account is required' });
  try { res.json({ roles: await awsEks.ssoListRoles(awsSession.sso, account) }); }
  catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

// Validate access-key / assume-role credentials and persist them as an ~/.aws
// profile so eks-token.js can read them at runtime.
app.post('/api/aws/configure', async (req, res) => {
  const { method, name, accessKeyId, secretAccessKey, sessionToken, region, roleArn, sourceProfile, sessionName } = req.body || {};
  const profile = (name || '').trim();
  if (!profile) return res.status(400).json({ error: 'A profile name is required' });
  try {
    const { credentials } = await awsEks.resolveCredentials(method, { accessKeyId, secretAccessKey, sessionToken, region, roleArn, sourceProfile, sessionName });
    await awsEks.validateCredentials(credentials, region); // fail fast on bad creds
    awsEks.saveProfile(profile, { accessKeyId, secretAccessKey, sessionToken, roleArn, sourceProfile, sessionName, region });
    res.json({ profile });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.post('/api/aws/clusters', async (req, res) => {
  const { profile, account, role } = req.body || {};
  try {
    const existing = new Set((kubeConfig?.contexts || []).map((c) => c.name));
    // Active SSO session with a chosen account + role → list that account's clusters.
    if (awsSession?.sso?.accessToken && account && role) {
      const credentials = await awsEks.ssoRoleCredentials(awsSession.sso, account, role);
      awsSession.ssoSelected = { account, role, credentials };
      const { clusters, regions } = await awsEks.discoverClusters({ credentials, account });
      awsSession.ssoClusters = new Map(clusters.map((c) => [`${c.region}/${c.name}`, { ...c, account, role }]));
      return res.json({ clusters: clusters.map((c) => ({ name: c.name, region: c.region, account, imported: existing.has(c.name) })), regions });
    }
    // Otherwise use a profile's credentials (access-key / role / existing).
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const credentials = await fromNodeProviderChain(profile ? { profile } : {})();
    const { clusters, regions } = await awsEks.discoverClusters({ credentials });
    res.json({ clusters: clusters.map((c) => ({ name: c.name, region: c.region, imported: existing.has(c.name) })), regions });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.post('/api/aws/import', async (req, res) => {
  const { clusters = [], profile } = req.body || {};
  if (!Array.isArray(clusters) || clusters.length === 0) return res.status(400).json({ error: 'No clusters selected' });
  const imported = [], failed = [];
  let fromNodeProviderChain;
  try {
    ({ fromNodeProviderChain } = await import('@aws-sdk/credential-providers'));
  } catch (e) {
    log.error('AWS SDK modules failed to load', { err: e });
    return res.status(500).json({ error: 'AWS SDK is unavailable in this build', code: 'aws_sdk_unavailable' });
  }

  for (const c of clusters) {
    if (!isResourceName(c?.name) || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(String(c?.region || ''))) { failed.push({ name: typeof c?.name === 'string' ? c.name.slice(0, 100) : '?', error: 'Missing or invalid cluster name or region' }); continue; }
    try {
      let credentials, credProfile = profile || undefined;
      const ssoInfo = awsSession?.ssoClusters?.get(`${c.region}/${c.name}`);
      if (awsSession?.sso?.accessToken && ssoInfo) {
        // Per-account SSO role credentials (short-lived) for the describe call,
        // plus an SSO *profile* (start URL / account / role — no static keys) so
        // the token helper can mint fresh credentials at runtime.
        credentials = await awsEks.ssoRoleCredentials(awsSession.sso, ssoInfo.account, ssoInfo.role);
        if (typeof awsEks.saveSsoProfile === 'function') {
          credProfile = await awsEks.saveSsoProfile(`sso-${ssoInfo.account}`, {
            startUrl: awsSession.sso.startUrl, ssoRegion: awsSession.sso.ssoRegion,
            accountId: ssoInfo.account, roleName: ssoInfo.role, region: c.region,
          });
        } else {
          credProfile = `sso-${ssoInfo.account}`;
          awsEks.saveProfile(credProfile, { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, region: c.region });
        }
      } else {
        credentials = await fromNodeProviderChain(profile ? { profile } : {})();
      }
      await awsEks.writeCluster({ credentials, region: c.region, name: c.name, alias: c.name, profile: credProfile });
      imported.push(c.name);
    } catch (e) {
      if (awsEks.KubeconfigParseError && e instanceof awsEks.KubeconfigParseError) {
        return res.status(409).json({ error: firstLine(e.message), code: 'kubeconfig_unparseable', imported, failed });
      }
      failed.push({ name: c.name, error: firstLine(e.message) });
    }
  }
  // Keep the user on the cluster they were already using.
  reloadPreservingContext();
  res.json({ imported, failed, contexts: kubeConfig?.contexts.map((c) => c.name) || [], currentContext });
});

// ------------------------------------------------------------------
// Bring-your-own AI agent — detect installed CLI agents and run them in a
// terminal with the cluster context loaded. No API key.
// ------------------------------------------------------------------
const AI_AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', desc: 'The coding assistant by Anthropic', install: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', desc: 'AI pair programmer by GitHub', install: 'https://github.com/github/gh-copilot' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', desc: 'Google Gemini in your terminal', install: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', desc: 'OpenAI Codex coding agent', install: 'https://github.com/openai/codex' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', desc: 'Open-source terminal AI agent', install: 'https://opencode.ai' },
];
// CLI detection / resolution lives in lib/kubectl.mjs (commandExists,
// resolveBinSync — process PATH + login-shell PATH + well-known bin dirs,
// with PATHEXT support on Windows). Warm the login-shell PATH cache early so
// the first pod terminal can resolve kubectl from a shell-configured location.
loginShellPath();
// Temp kubeconfigs handed to agent terminals: delete after 12 h as a safety
// net in case the shell never ran its own cleanup.
const TEMP_KUBECONFIG_TTL_MS = 12 * 60 * 60 * 1000;
const scheduleTempUnlink = (p) => setTimeout(() => fs.unlink(p, () => {}), TEMP_KUBECONFIG_TTL_MS).unref();
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
app.get('/api/ai-agents', async (req, res) => {
  const agents = await Promise.all(AI_AGENTS.map(async (a) => ({ id: a.id, name: a.name, command: a.command, desc: a.desc, install: a.install, installed: await commandExists(a.command) })));
  res.json({ agents });
});

// Launch the chosen agent in a *native* OS terminal window (rather than the
// in-app terminal panel) — the "Open AI tools in an external terminal" option.
// Writes a temp kubeconfig pinned to the app's current context, then opens the
// platform terminal running the agent CLI. macOS/Linux; best-effort.
app.post('/api/ai-agents/launch-external', (req, res) => {
  try {
    // Only a known agent id may be launched — no free-form command.
    const { agentId, prompt } = req.body || {};
    const info = AI_AGENTS.find((a) => a.id === agentId);
    if (!info) return res.status(400).json({ error: 'Unknown AI agent', code: 'invalid_param', field: 'agentId' });
    if (prompt != null && (typeof prompt !== 'string' || prompt.length > 16384)) return bad(res, 'prompt');
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const command = info.command;

    // Temp kubeconfig with the app's in-memory current context.
    const kubeconfigPath = path.join(os.tmpdir(), `km-agent-${randomUUID()}.yaml`);
    fs.writeFileSync(kubeconfigPath, kubeConfig.exportConfig(), { mode: 0o600 });
    scheduleTempUnlink(kubeconfigPath);

    const launch = prompt ? `${command} ${shq(prompt)}` : command;
    // A small launcher script: pin the kubeconfig, print a banner, run the agent,
    // then keep the shell open so its output stays visible. The trap removes the
    // temp kubeconfig even if the agent is interrupted before the rm line.
    const script = path.join(os.tmpdir(), `km-agent-${randomUUID()}.sh`);
    scheduleTempUnlink(script);
    const body = [
      '#!/bin/bash',
      `trap 'rm -f ${shq(kubeconfigPath)} ${shq(script)}' EXIT INT TERM`,
      `export KUBECONFIG=${shq(kubeconfigPath)}`,
      `export KUBE_CONTEXT=${shq(currentContext || '')}`,
      `echo ${shq(`Cluster context: ${currentContext || '(default)'}`)}`,
      launch,
      `rm -f ${shq(kubeconfigPath)} ${shq(script)}`,
      'trap - EXIT',
      'exec $SHELL -l',
    ].join('\n');
    fs.writeFileSync(script, body, { mode: 0o700 });

    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Terminal', script], () => { /* fire and forget */ });
    } else if (process.platform === 'linux') {
      // Try a few common terminal emulators.
      const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
      const tryNext = (i) => {
        if (i >= term.length) return;
        execFile(term[i], ['-e', 'bash', script], (err) => { if (err) tryNext(i + 1); });
      };
      tryNext(0);
    } else {
      try { fs.unlinkSync(kubeconfigPath); fs.unlinkSync(script); } catch { /* ignore */ }
      return res.status(400).json({ error: 'External terminal is only supported on macOS and Linux' });
    }
    res.json({ ok: true });
  } catch (err) {
    log.error('launch-external failed', { err });
    res.status(500).json({ error: 'Failed to launch external terminal', code: 'internal_error' });
  }
});

// ------------------------------------------------------------------
// Authentication / connectivity check
//
// /api/config/status only tells us the kubeconfig file *parsed*. It does not
// tell us whether the credentials actually work — a token can be expired, the
// API server unreachable, TLS untrusted, or an exec auth plugin (aws-iam-
// authenticator, gke-gcloud-auth-plugin, …) missing. This endpoint makes one
// lightweight authenticated call and classifies the outcome so the UI can show
// an actionable popup before loading the app.
// ------------------------------------------------------------------
const currentServerUrl = () => {
  try { return kubeConfig?.getCurrentCluster()?.server || null; } catch { return null; }
};

// Exec-plugin failures surface as `new Error(<stderr>)` (non-zero exit), the
// spawn error (ENOENT) or a JSON SyntaxError when stdout was empty/garbage —
// the latter says nothing about *which* plugin ran, so the current user's
// exec entry is passed in as context.
const SSO_EXPIRED_RE = /SSO session .*expired|aws sso login|Token has expired|ExpiredToken|The security token included in the request is invalid/i;
const OUR_HELPER_RE = /token-helper|eks-token|azure-token/i;
const HELPER_FAILED_RE = /Unexpected end of JSON input|Unexpected token|is not valid JSON|exit code|ENOENT/i;

const classifyClusterError = (error, { exec, repaired = false } = {}) => {
  // client-node 2.0 throws ApiException with a numeric `.code` (HTTP status)
  // and a parsed `.body`; fetch network failures carry a string `.cause.code`.
  const num = (v) => (typeof v === 'number' ? v : undefined);
  const httpStatus = num(error?.code) ?? error?.statusCode ?? error?.response?.statusCode ?? num(error?.body?.code);
  const code = error?.cause?.code || (typeof error?.code === 'string' ? error.code : undefined);
  const msg = error?.body?.message || error?.body?.reason || error?.message || String(error);
  const execDesc = exec ? [exec.command, ...(Array.isArray(exec.args) ? exec.args : [])].filter((s) => typeof s === 'string').join(' ') : '';
  const ourHelper = OUR_HELPER_RE.test(execDesc) || OUR_HELPER_RE.test(msg);

  if (httpStatus === undefined && SSO_EXPIRED_RE.test(msg)) {
    return { ok: false, reason: 'sso-expired', message: 'Your AWS SSO session has expired. Sign in again to refresh it.', detail: msg };
  }
  if (httpStatus === undefined && ourHelper && (error instanceof SyntaxError || code === 'ENOENT' || HELPER_FAILED_RE.test(msg))) {
    return {
      ok: false, reason: 'exec-helper',
      message: repaired
        ? 'The kubeconfig auth helper for this cluster failed to run. Its kubeconfig entry was out of date and has been repaired — click Retry.'
        : 'The kubeconfig auth helper for this cluster failed to run. Click Retry; if it keeps failing, re-import the cluster from Add cluster.',
      detail: msg,
    };
  }

  if (httpStatus === 401) {
    return {
      ok: false, reason: 'unauthorized',
      message: 'Authentication failed (HTTP 401). Your credentials were rejected — the token or client certificate may be expired or invalid.'
    };
  }
  if (httpStatus === 403) {
    // Credentials are valid; the user simply can't list namespaces. Still authenticated.
    return {
      ok: true, authenticated: true, reachable: true, limited: true,
      message: 'Authenticated, but this user has limited RBAC permissions.'
    };
  }
  const tlsCodes = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'];
  if (code && tlsCodes.includes(code)) {
    return { ok: false, reason: 'tls', message: `TLS certificate error (${code}) contacting the cluster API server.` };
  }
  if (code && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) {
    return { ok: false, reason: 'unreachable', message: `Cannot reach the cluster API server (${code}). Check the server URL, your VPN/network, or that the cluster is running.` };
  }
  if (code === 'ENOENT' || /exec plugin|no such file|ENOENT|not found|credential plugin/i.test(msg)) {
    return {
      ok: false, reason: 'exec-plugin',
      message: `Failed to run the kubeconfig auth plugin: ${msg}. Ensure the required CLI (e.g. aws-iam-authenticator, gke-gcloud-auth-plugin) is installed and on PATH.`
    };
  }
  return { ok: false, reason: 'error', message: msg };
};

const checkClusterAuth = async () => {
  if (!kubeConfig) return { ok: false, reason: 'no-config', message: 'No kubeconfig is loaded.' };
  const server = currentServerUrl();
  try {
    const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
    // Lightweight authenticated request (limit=1). 200 ⇒ authenticated + reachable.
    await core.listNamespace({ limit: 1 });
    return { ok: true, authenticated: true, reachable: true, currentContext, server };
  } catch (error) {
    let exec = null;
    try { exec = kubeConfig.getCurrentUser()?.exec || null; } catch { /* no user */ }
    let classified = classifyClusterError(error, { exec });
    if (classified.reason === 'exec-helper') {
      // Our helper entry failed — repair the on-disk file (stale command,
      // legacy ELECTRON_RUN_AS_NODE form) and reload so Retry picks it up.
      const repaired = repairKubeconfigFiles(activeKubeconfigPath || (kubeconfigEnvPaths().length ? undefined : getKubeConfigPath()));
      if (repaired > 0) {
        reloadPreservingContext();
        classified = classifyClusterError(error, { exec, repaired: true });
      }
    }
    return { ...classified, currentContext, server };
  }
};

// Always responds 200 with an `ok` flag so the client can render details
// (rather than having to catch an HTTP error).
app.get('/api/config/auth', async (req, res) => {
  try {
    res.json(await checkClusterAuth());
  } catch (error) {
    res.json({ ok: false, reason: 'error', message: error.message });
  }
});

app.get('/api/namespaces', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('namespaces');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const response = await api.listNamespace();
    const items = response.items;
    const namespaces = items.map(ns => ns.metadata.name);
    const details = items.map(ns => ({
      name: ns.metadata.name,
      status: ns.status?.phase || 'Active',
      createdAt: ns.metadata.creationTimestamp,
      labels: ns.metadata.labels || {}
    }));
    const result = { namespaces, details };

    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

// Fan-out helper: run several named list calls in parallel. A subset failing
// (RBAC on one kind) yields a partial result — `{ partial: true, errors }` —
// while ALL failing is a real error and is thrown.
const fanOut = async (calls) => {
  const entries = Object.entries(calls);
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn()));
  const items = {}, errors = [];
  settled.forEach((r, i) => {
    const key = entries[i][0];
    if (r.status === 'fulfilled') items[key] = r.value?.items || [];
    else { items[key] = []; errors.push({ kind: key, error: firstLine(r.reason?.body?.message || r.reason?.message || String(r.reason)) }); }
  });
  if (errors.length && errors.length === entries.length) throw settled[0].reason;
  return { items, errors };
};

app.get('/api/resources/:namespace', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const namespace = req.params.namespace;
    if (namespace === '-' || namespace === 'all') return bad(res, 'namespace');
    const cacheKey = getCacheKey('resources', { namespace });

    // Check cache first
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
    const netApi = kubeConfig.makeApiClient(k8s.NetworkingV1Api);

    // All in-process API calls (no kubectl process spawn), fetched in parallel
    const { items: r, errors } = await fanOut({
      pods: () => coreApi.listNamespacedPod({ namespace }),
      services: () => coreApi.listNamespacedService({ namespace }),
      deployments: () => appsApi.listNamespacedDeployment({ namespace }),
      statefulSets: () => appsApi.listNamespacedStatefulSet({ namespace }),
      daemonSets: () => appsApi.listNamespacedDaemonSet({ namespace }),
      configMaps: () => coreApi.listNamespacedConfigMap({ namespace }),
      secrets: () => coreApi.listNamespacedSecret({ namespace }),
      serviceAccounts: () => coreApi.listNamespacedServiceAccount({ namespace }),
      ingresses: () => netApi.listNamespacedIngress({ namespace }),
      networkPolicies: () => netApi.listNamespacedNetworkPolicy({ namespace }),
      persistentVolumeClaims: () => coreApi.listNamespacedPersistentVolumeClaim({ namespace }),
    });

    const resources = {
      pods: r.pods.map(item => formatResource(item, 'Pod')),
      services: r.services.map(item => formatResource(item, 'Service')),
      deployments: r.deployments.map(item => formatResource(item, 'Deployment')),
      statefulSets: r.statefulSets.map(item => formatResource(item, 'StatefulSet')),
      daemonSets: r.daemonSets.map(item => formatResource(item, 'DaemonSet')),
      configMaps: r.configMaps.map(item => formatResource(item, 'ConfigMap')),
      secrets: r.secrets.map(item => formatResource(item, 'Secret')),
      serviceAccounts: r.serviceAccounts.map(item => formatResource(item, 'ServiceAccount')),
      ingresses: r.ingresses.map(item => formatResource(item, 'Ingress')),
      networkPolicies: r.networkPolicies.map(item => formatResource(item, 'NetworkPolicy')),
      persistentVolumeClaims: r.persistentVolumeClaims.map(item => formatResource(item, 'PersistentVolumeClaim'))
    };
    if (errors.length) { resources.partial = true; resources.errors = errors; }

    // Cache the response (a partial one only briefly, so a transient failure recovers)
    setCache(cacheKey, resources, errors.length ? 5000 : CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(resources);
  } catch (error) {
    fail(res, error);
  }
});

// Cluster-scoped storage: PersistentVolumes + StorageClasses (not per-namespace)
app.get('/api/storage', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('storage');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const storageApi = kubeConfig.makeApiClient(k8s.StorageV1Api);

    const { items: r, errors } = await fanOut({
      persistentVolumes: () => coreApi.listPersistentVolume(),
      storageClasses: () => storageApi.listStorageClass(),
    });

    const result = {
      persistentVolumes: r.persistentVolumes.map(item => formatResource(item, 'PersistentVolume')),
      storageClasses: r.storageClasses.map(item => formatResource(item, 'StorageClass'))
    };
    if (errors.length) { result.partial = true; result.errors = errors; }

    setCache(cacheKey, result, errors.length ? 5000 : CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

// Access Control (RBAC): roles, bindings, cluster roles/bindings, service accounts
app.get('/api/rbac', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('rbac');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const rbac = kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
    const core = kubeConfig.makeApiClient(k8s.CoreV1Api);

    const { items: r, errors } = await fanOut({
      roles: () => rbac.listRoleForAllNamespaces(),
      roleBindings: () => rbac.listRoleBindingForAllNamespaces(),
      clusterRoles: () => rbac.listClusterRole(),
      clusterRoleBindings: () => rbac.listClusterRoleBinding(),
      sas: () => core.listServiceAccountForAllNamespaces(),
    });
    const [roles, roleBindings, clusterRoles, clusterRoleBindings, sas] =
      [r.roles, r.roleBindings, r.clusterRoles, r.clusterRoleBindings, r.sas].map((items) => ({ items }));

    const base = (i) => ({
      name: i.metadata.name,
      namespace: i.metadata.namespace || '-',
      createdAt: i.metadata.creationTimestamp
    });
    const binding = (i) => ({
      ...base(i),
      roleRef: i.roleRef ? `${i.roleRef.kind}/${i.roleRef.name}` : '-',
      subjects: (i.subjects || []).length
    });

    const result = {
      serviceAccounts: sas.items.map(i => ({ ...base(i), secrets: (i.secrets || []).length })),
      roles: roles.items.map(i => ({ ...base(i), rules: (i.rules || []).length })),
      roleBindings: roleBindings.items.map(binding),
      clusterRoles: clusterRoles.items.map(i => ({ ...base(i), rules: (i.rules || []).length })),
      clusterRoleBindings: clusterRoleBindings.items.map(binding)
    };
    if (errors.length) { result.partial = true; result.errors = errors; }

    setCache(cacheKey, result, errors.length ? 5000 : CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/resource/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, kind, name } = req.params;

    let resource;
    try {
      switch(kind) {
        case 'Pod':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPod({ name, namespace });
          break;
        case 'Service':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedService({ name, namespace });
          break;
        case 'Deployment':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDeployment({ name, namespace });
          break;
        case 'StatefulSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedStatefulSet({ name, namespace });
          break;
        case 'DaemonSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDaemonSet({ name, namespace });
          break;
        case 'ConfigMap':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ name, namespace });
          break;
        case 'Secret':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedSecret({ name, namespace });
          break;
        case 'ServiceAccount':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedServiceAccount({ name, namespace });
          break;
        case 'Role':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRole({ name, namespace });
          break;
        case 'RoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRoleBinding({ name, namespace });
          break;
        case 'ClusterRole':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRole({ name });
          break;
        case 'ClusterRoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRoleBinding({ name });
          break;
        case 'Ingress':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress({ name, namespace });
          break;
        case 'NetworkPolicy':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedNetworkPolicy({ name, namespace });
          break;
        case 'PersistentVolumeClaim':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPersistentVolumeClaim({ name, namespace });
          break;
        case 'PersistentVolume':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readPersistentVolume({ name });
          break;
        case 'StorageClass':
          resource = await kubeConfig.makeApiClient(k8s.StorageV1Api).readStorageClass({ name });
          break;
        default:
          return res.status(400).json({ error: 'Unsupported resource kind' });
      }
    } catch (apiError) {
      // K8s 404 → 404; 401/403 → 403 forbidden; anything else → 502 upstream_error
      return fail(res, apiError, undefined, 'Failed to read resource');
    }

    res.json(resource);
  } catch (error) {
    fail(res, error);
  }
});

const LOG_TAIL_DEFAULT = 1000, LOG_TAIL_MAX = 20000, LOG_LIMIT_BYTES = 8 * 1024 * 1024;

app.get('/api/logs/:namespace/:pod', async (req, res) => {
  const { namespace, pod } = req.params;
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const container = req.query.container ? String(req.query.container) : undefined;
    if (container !== undefined && !isContainer(container)) return bad(res, 'container');
    if (req.query.tail !== undefined && !isIntInRange(req.query.tail, 1, LOG_TAIL_MAX)) return bad(res, 'tail', `tail must be an integer between 1 and ${LOG_TAIL_MAX}`);
    const tail = req.query.tail !== undefined ? Number(req.query.tail) : LOG_TAIL_DEFAULT; // last N lines
    const timestamps = req.query.timestamps === 'true'; // prefix each line with an RFC3339 timestamp
    const cacheKey = getCacheKey('logs', { namespace, pod, container, tail, timestamps });

    // Check cache
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
    // client-node 2.0 returns the log body as a string directly.
    let logs = await api.readNamespacedPodLog({ name: pod, namespace, container, tailLines: tail, timestamps, limitBytes: LOG_LIMIT_BYTES });

    if (Buffer.isBuffer(logs)) {
      logs = logs.toString('utf8');
    }

    logs = logs || 'No logs available';
    const result = { logs };

    setCache(cacheKey, result, CACHE_TTL.logs);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    log.warn('failed to get pod logs', { namespace, pod, err: error });
    fail(res, error, undefined, 'Failed to get logs');
  }
});

app.post('/api/exec', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, pod, command, container } = req.body || {};

    if (!namespace || !pod || !command) {
      return res.status(400).json({ error: 'Missing namespace, pod, or command', code: 'invalid_param', field: !namespace ? 'namespace' : (!pod ? 'pod' : 'command') });
    }
    if (!checkParams(res, [
      ['namespace', namespace, isDnsLabel],
      ['pod', pod, isDnsSubdomain],
      ['container', container, (v) => v == null || v === '' || isContainer(v)],
      ['command', command, (v) => typeof v === 'string' && v.length <= 65536],
    ])) return;

    // With kubectl installed, exec through it (proven against every auth
    // plugin). Without it, exec over the API's WebSocket (lib/k8s-ops.mjs) so
    // a CLI-free machine can still run one-shot commands. The command is a
    // single `sh -c` argument either way (no local shell interpolation).
    let result;
    try {
      if ((await hasKubectl()).available) {
        // The pod name is validated above (a DNS subdomain can never start
        // with '-'); kubectl exec needs it BEFORE the `--`.
        const args = ['exec', `--namespace=${namespace}`];
        if (container) args.push(`--container=${container}`);
        args.push(pod, '--', 'sh', '-c', command);
        result = await execKubectl(args, { timeoutMs: 30000, maxBuffer: 10 * 1024 * 1024 });
      } else {
        result = await execInPod(kubeConfig, { namespace, pod, container: container || undefined, command, timeoutMs: 30000 });
      }
    } catch (error) {
      return res.json({ output: error.body?.message || error.message, code: -1 });
    }
    const output = (result.stdout || '') + (result.stderr || '');
    res.json({ output, code: result.code == null ? 0 : result.code });
  } catch (error) {
    fail(res, error);
  }
});

// ============================================================
// Port forwarding to local (kubectl port-forward svc/<name>)
// ============================================================
const portForwards = new Map(); // id -> { id, namespace, name, remotePort, localPort, proc, status, startedAt, error }
let pfCounter = 0;
const MAX_PORT_FORWARDS = 20;
const PF_STOPPED_RETENTION_MS = 60_000;
const livePortForwards = () => [...portForwards.values()].filter((f) => f.status === 'starting' || f.status === 'active').length;
const retireForward = (entry) => {
  setTimeout(() => { if (portForwards.get(entry.id) === entry && entry.status !== 'active') portForwards.delete(entry.id); }, PF_STOPPED_RETENTION_MS).unref();
};

app.post('/api/portforward', mcpWriteGate, async (req, res) => {
  if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
  // Port-forward is one of the two features that genuinely need kubectl.
  if (!(await hasKubectl()).available) return fail(res, kubectlMissingError());
  const { namespace, name, remotePort } = req.body || {};
  if (!namespace || !name || !remotePort) {
    return res.status(400).json({ error: 'Missing namespace, name, or remotePort', code: 'invalid_param', field: !namespace ? 'namespace' : (!name ? 'name' : 'remotePort') });
  }
  if (!checkParams(res, [
    ['namespace', namespace, isDnsLabel],
    ['name', name, isDnsSubdomain],
    ['remotePort', remotePort, isPort],
    ['localPort', req.body.localPort, (v) => v == null || v === '' || isPort(v)],
  ])) return;
  const localPort = req.body.localPort ? Number(req.body.localPort) : null;
  if (livePortForwards() >= MAX_PORT_FORWARDS) {
    return res.status(429).json({ error: `At most ${MAX_PORT_FORWARDS} port-forwards may be active at once`, code: 'too_many_port_forwards' });
  }

  // No local port -> ":remote" lets kubectl pick a random free local port.
  // Always bind loopback only.
  const portArg = localPort ? `${localPort}:${Number(remotePort)}` : `:${Number(remotePort)}`;
  let proc;
  try { proc = spawnKubectl(['port-forward', `--namespace=${namespace}`, '--address=127.0.0.1', ...positional(`svc/${name}`, portArg)]); }
  catch (e) {
    if (isSpawnMissing(e)) return fail(res, kubectlMissingError());
    return res.status(500).json({ error: `Failed to start kubectl: ${e.message}`, code: 'spawn_failed' });
  }

  const id = `pf-${++pfCounter}`;
  const entry = { id, namespace, name, remotePort: Number(remotePort), localPort, proc, status: 'starting', startedAt: Date.now(), error: '' };
  portForwards.set(id, entry);

  let responded = false;
  const respond = (fn) => { if (!responded) { responded = true; fn(); } };

  const timer = setTimeout(() => {
    respond(() => res.status(504).json({ error: 'Timed out starting port-forward', code: 'timeout' }));
    try { proc.kill(); } catch (e) { /* ignore */ }
    entry.status = 'stopped';
    retireForward(entry);
  }, 10000);

  proc.stdout.on('data', (data) => {
    const m = data.toString().match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (m) {
      entry.localPort = parseInt(m[1], 10);
      entry.status = 'active';
      clearTimeout(timer);
      respond(() => res.json({ id, namespace, name, remotePort: entry.remotePort, localPort: entry.localPort, status: 'active', startedAt: entry.startedAt }));
    }
  });
  proc.stderr.on('data', (data) => { if (entry.error.length < 8192) entry.error += data.toString(); });
  proc.on('exit', (code) => {
    entry.status = 'stopped';
    clearTimeout(timer);
    retireForward(entry);
    respond(() => res.status(502).json({ error: (entry.error || `port-forward exited (code ${code})`).trim(), code: 'upstream_error' }));
  });
  proc.on('error', (err) => {
    entry.status = 'error';
    clearTimeout(timer);
    retireForward(entry);
    respond(() => (isSpawnMissing(err)
      ? fail(res, kubectlMissingError())
      : res.status(502).json({ error: err.message, code: 'upstream_error' })));
  });
});

app.get('/api/portforward', (req, res) => {
  const forwards = Array.from(portForwards.values())
    .filter(f => f.status === 'active')
    .map(({ id, namespace, name, remotePort, localPort, status, startedAt }) =>
      ({ id, namespace, name, remotePort, localPort, status, startedAt }));
  res.json({ forwards });
});

app.delete('/api/portforward/:id', (req, res) => {
  const entry = portForwards.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Port-forward not found', code: 'not_found' });
  try { entry.proc.kill(); } catch (e) { /* ignore */ }
  portForwards.delete(req.params.id);
  res.json({ success: true });
});

// Kill all forwards when the server shuts down (see shutdown() at the bottom).
const killAllForwards = () => {
  for (const entry of portForwards.values()) {
    try { entry.proc.kill(); } catch (e) { /* ignore */ }
  }
};
process.on('exit', killAllForwards);

app.get('/api/yaml/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, kind, name } = req.params;

    let resource;
    try {
      switch(kind) {
        case 'pod':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPod({ name, namespace });
          break;
        case 'service':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedService({ name, namespace });
          break;
        case 'deployment':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDeployment({ name, namespace });
          break;
        case 'statefulSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedStatefulSet({ name, namespace });
          break;
        case 'daemonSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDaemonSet({ name, namespace });
          break;
        case 'configMap':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ name, namespace });
          break;
        case 'secret':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedSecret({ name, namespace });
          break;
        case 'serviceAccount':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedServiceAccount({ name, namespace });
          break;
        case 'role':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRole({ name, namespace });
          break;
        case 'roleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRoleBinding({ name, namespace });
          break;
        case 'clusterRole':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRole({ name });
          break;
        case 'clusterRoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRoleBinding({ name });
          break;
        case 'ingress':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress({ name, namespace });
          break;
        case 'networkPolicy':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedNetworkPolicy({ name, namespace });
          break;
        case 'persistentVolumeClaim':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPersistentVolumeClaim({ name, namespace });
          break;
        case 'persistentVolume':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readPersistentVolume({ name });
          break;
        case 'storageClass':
          resource = await kubeConfig.makeApiClient(k8s.StorageV1Api).readStorageClass({ name });
          break;
        default:
          return res.status(400).json({ error: 'Unsupported resource kind' });
      }
    } catch (apiError) {
      return fail(res, apiError, undefined, 'Failed to read resource');
    }

    const yamlString = yaml.dump(resource, { indent: 2 });
    res.json({ yaml: yamlString });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------
// Resource write operations (edit/apply, delete, scale, rollout restart).
// These shell out to kubectl so a single code path works for every kind.
// The camelCase resourceType lowercases to a valid kubectl resource name
// (statefulSet → statefulset, configMap → configmap, …).
// ------------------------------------------------------------------
const CLUSTER_SCOPED_KINDS = new Set([
  'persistentvolume', 'storageclass', 'clusterrole', 'clusterrolebinding',
  'node', 'namespace', 'customresourcedefinition',
]);

// Writes go through the Kubernetes API (lib/k8s-ops.mjs) on the current
// in-memory context: server-side apply, delete, /scale patches and the
// rollout-restart annotation patch. Only a kind whose REST mapping cannot be
// resolved (neither built-in nor a CRD on the cluster) falls back to kubectl.
const effectiveNamespace = (kind, namespace) =>
  (!namespace || namespace === '-' || namespace === 'all' || CLUSTER_SCOPED_KINDS.has(kind)) ? undefined : namespace;
// Discovery cache scope: the cluster behind the current context.
const discoveryScope = () => `${currentContext || ''}|${currentServerUrl() || ''}`;
// Namespace a manifest without metadata.namespace lands in (kubectl: the
// context's namespace, else "default").
const contextNamespace = () => {
  try { return kubeConfig.getContextObject(currentContext)?.namespace || 'default'; } catch { return 'default'; }
};
// Resolve a :kind segment: built-ins first, then the cluster's CRDs.
const mappingForKind = async (kind) => restMappingFor(kind) || restMappingFor(kind, await crdIndex());

// Apply edited YAML (create-or-update). Body: { yaml }. The body must describe
// exactly the resource named in the path.
app.put('/api/yaml/:namespace/:kind/:name', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const { yaml: yamlText } = req.body || {};
    const docs = parseApplyDocuments(yamlText);
    if (docs.length !== 1) throw badRequest('Exactly one YAML document is expected', 'invalid_yaml');
    const doc = docs[0];
    const k = kind.toLowerCase();
    if (String(doc.kind || '').toLowerCase() !== k) throw badRequest(`YAML kind "${doc.kind || ''}" does not match the path (${kind})`, 'yaml_mismatch');
    if (doc.metadata?.name !== name) throw badRequest(`YAML metadata.name "${doc.metadata?.name || ''}" does not match the path (${name})`, 'yaml_mismatch');
    if (!CLUSTER_SCOPED_KINDS.has(k) && namespace !== '-') {
      if (doc.metadata?.namespace !== namespace) throw badRequest(`YAML metadata.namespace "${doc.metadata?.namespace || ''}" does not match the path (${namespace})`, 'yaml_mismatch');
    }
    const messages = await applyDocuments(kubeConfig, docs, { scope: discoveryScope(), defaultNamespace: effectiveNamespace(k, namespace) || contextNamespace() });
    cache.clear();
    res.json({ success: true, message: messages.join('\n') || 'Applied' });
  } catch (error) {
    fail(res, error);
  }
});

// Apply arbitrary YAML by content (no resource in the path). Used by the MCP
// apply_yaml tool. Body: { yaml }
app.post('/api/apply', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { yaml: yamlText } = req.body || {};
    const docs = parseApplyDocuments(yamlText);
    // Server-side apply, one document at a time (== `kubectl apply -f -`).
    const messages = await applyDocuments(kubeConfig, docs, { scope: discoveryScope(), defaultNamespace: contextNamespace() });
    cache.clear();
    res.json({ success: true, message: messages.join('\n') || 'Applied' });
  } catch (error) {
    fail(res, error);
  }
});

// Delete a resource
app.delete('/api/resource/:namespace/:kind/:name', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const k = kind.toLowerCase();
    const m = await mappingForKind(k);
    let message;
    if (m) {
      ({ message } = await deleteResource(kubeConfig, m, { name, namespace: effectiveNamespace(k, namespace), scope: discoveryScope() }));
    } else {
      // Not a built-in kind and not a CRD on this cluster: let kubectl try its
      // own resolution (aliases, categories) — if it is installed.
      if (!(await hasKubectl()).available) {
        return res.status(400).json({
          error: `Unknown resource kind "${kind}": it is neither a built-in kind nor a CRD on this cluster, and kubectl is not installed to resolve it. Install kubectl from https://kubernetes.io/docs/tasks/tools/ or use the resource's full name (plural.group).`,
          code: 'unknown_kind',
        });
      }
      const ns = effectiveNamespace(k, namespace);
      message = await runKubectl(['delete', ...(ns ? [`--namespace=${ns}`] : []), ...positional(k, name)]);
    }
    cache.clear();
    res.json({ success: true, message: message || `${name} deleted` });
  } catch (error) {
    fail(res, error);
  }
});

// Scale a workload. Body: { replicas }
app.post('/api/scale/:namespace/:kind/:name', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    if (!isIntInRange(req.body?.replicas, 0, 10000)) return bad(res, 'replicas', 'replicas must be an integer between 0 and 10000');
    const replicas = Number(req.body.replicas);
    const k = kind.toLowerCase();
    // Merge-patch the /scale subresource (400 for DaemonSets and other unscalable kinds).
    const { api, method } = scaleTarget(k);
    if (!effectiveNamespace(k, namespace)) return bad(res, 'namespace');
    await kubeConfig.makeApiClient(k8s[api])[method]({ name, namespace, body: scalePatch(replicas) }, patchOptions(PatchStrategy.MergePatch, 20000));
    cache.clear();
    res.json({ success: true, message: `${resourceLabel(restMappingFor(k), name)} scaled` });
  } catch (error) {
    fail(res, error);
  }
});

// Rollout-restart a workload
app.post('/api/restart/:namespace/:kind/:name', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const k = kind.toLowerCase();
    // Strategic-merge patch of the pod template's restartedAt annotation —
    // exactly what `kubectl rollout restart` sends.
    const { api, method } = restartTarget(k);
    if (!effectiveNamespace(k, namespace)) return bad(res, 'namespace');
    await kubeConfig.makeApiClient(k8s[api])[method]({ name, namespace, body: restartPatch() }, patchOptions(PatchStrategy.StrategicMergePatch, 20000));
    cache.clear();
    res.json({ success: true, message: `${resourceLabel(restMappingFor(k), name)} restarted` });
  } catch (error) {
    fail(res, error);
  }
});

// Events use whichever timestamp the API filled in (eventTime for the new
// events API, last/first for core v1) — otherwise `age` was NaN.
const eventTime = (e) => e.eventTime || e.lastTimestamp || e.firstTimestamp || e.metadata?.creationTimestamp || null;

app.get('/api/events/:namespace?', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace } = req.params;
    if (req.query.page !== undefined && !isIntInRange(req.query.page, 1, 1_000_000)) return bad(res, 'page');
    if (req.query.limit !== undefined && !isIntInRange(req.query.limit, 1, 100)) return bad(res, 'limit');
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50; // Max 100 per page
    const cacheKey = getCacheKey('events', { namespace, page, limit });

    // Check cache
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);

    let response;
    if (namespace && namespace !== 'all' && namespace !== '-') {
      response = await coreApi.listNamespacedEvent({ namespace });
    } else {
      response = await coreApi.listEventForAllNamespaces();
    }

    const now = Date.now();
    const events = response.items.map(event => {
      const ts = eventTime(event);
      const t = ts ? new Date(ts).getTime() : NaN;
      return {
        message: event.message,
        namespace: event.metadata?.namespace,
        type: event.type,
        reason: event.reason,
        involvedObject: (event.involvedObject?.kind || '') + '/' + (event.involvedObject?.name || ''),
        source: event.source?.component || event.source?.host || event.reportingComponent || '',
        count: event.count,
        firstTimestamp: event.firstTimestamp || event.eventTime || null,
        lastTimestamp: ts,
        age: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : null,
      };
    });

    // Sort by lastTimestamp descending (newest first)
    events.sort((a, b) => (new Date(b.lastTimestamp).getTime() || 0) - (new Date(a.lastTimestamp).getTime() || 0));

    // Pagination
    const total = events.length;
    const start = (page - 1) * limit;
    const paginatedEvents = events.slice(start, start + limit);

    const result = {
      events: paginatedEvents,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };

    setCache(cacheKey, result, CACHE_TTL.events);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    // A failed list is an error, not an empty page.
    fail(res, error, { events: [] }, 'Failed to list events');
  }
});

// Nodes via the API (current in-memory context). Throws on failure — callers
// decide whether a missing node list is fatal (/api/nodes) or partial (summary).
const fetchNodes = async () => {
  const data = await kubeConfig.makeApiClient(k8s.CoreV1Api).listNode({}, requestOptions(15000));
  return data.items || [];
};

function formatNode(item) {
  const conditions = item.status?.conditions || [];
  const readyCondition = conditions.find(c => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';

  const labels = item.metadata?.labels || {};
  const roles = Object.keys(labels)
    .filter(key => key.startsWith('node-role.kubernetes.io/'))
    .map(key => key.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean);

  const addresses = item.status?.addresses || [];
  const internalIp = addresses.find(a => a.type === 'InternalIP')?.address || '-';
  const externalIp = addresses.find(a => a.type === 'ExternalIP')?.address || '-';

  const taints = item.spec?.taints || [];

  return {
    name: item.metadata.name,
    status: isReady ? 'Ready' : 'NotReady',
    roles: roles.length > 0 ? roles.join(', ') : 'worker',
    version: item.status?.nodeInfo?.kubeletVersion || '-',
    os: item.status?.nodeInfo?.osImage || '-',
    kernelVersion: item.status?.nodeInfo?.kernelVersion || '-',
    containerRuntime: item.status?.nodeInfo?.containerRuntimeVersion || '-',
    internalIp,
    externalIp,
    cpuCapacity: item.status?.capacity?.cpu || '-',
    memoryCapacity: item.status?.capacity?.memory || '-',
    cpuAllocatable: item.status?.allocatable?.cpu || '-',
    memoryAllocatable: item.status?.allocatable?.memory || '-',
    createdAt: item.metadata.creationTimestamp,
    unschedulable: !!item.spec?.unschedulable,
    taints: taints.length
  };
}

app.get('/api/nodes', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('nodes');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const nodes = (await fetchNodes()).map(formatNode);
    const result = { nodes };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { nodes: [] }, 'Failed to list nodes');
  }
});

// Pods scheduled on one node (the node name is validated by the :name param
// rule and only ever used as a field-selector value).
const fetchPodsForNode = async (nodeName) => {
  const data = await kubeConfig.makeApiClient(k8s.CoreV1Api)
    .listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${nodeName}` }, requestOptions(15000));
  return data.items || [];
};

function formatPodForNode(item) {
  const containerStatuses = item.status?.containerStatuses || [];
  const readyCount = containerStatuses.filter(c => c.ready).length;
  const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);

  return {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    status: item.status?.phase || 'Unknown',
    ready: `${readyCount}/${containerStatuses.length}`,
    restarts,
    createdAt: item.metadata.creationTimestamp
  };
}

app.get('/api/nodes/:name/pods', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { name } = req.params;
    const cacheKey = getCacheKey('node-pods', { name });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const pods = (await fetchPodsForNode(name)).map(formatPodForNode);
    const result = { pods };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { pods: [] }, 'Failed to list node pods');
  }
});

// ------------------------------------------------------------------
// Helm — read release storage directly via the Kubernetes API.
//
// Helm has no official JS SDK, but it persists each release revision as a
// Secret of type `helm.sh/release.v1` (labeled `owner=helm`) in the release's
// namespace. The `data.release` field is base64(gzip(json)) — and Kubernetes
// base64-encodes Secret data on top of that. Decoding it gives us everything
// `helm list` / `helm get values` / `helm get manifest` would return, with no
// CLI dependency.
// ------------------------------------------------------------------
const HELM_RELEASE_MAGIC_GZIP = [0x1f, 0x8b, 0x08];

// Decode a Helm release Secret into the stored release object.
const decodeHelmRelease = (secret) => {
  const encoded = secret?.data?.release;
  if (!encoded) return null;
  try {
    // Layer 1: Kubernetes returns Secret data base64-encoded → the Helm blob.
    let buf = Buffer.from(encoded, 'base64');
    // Layer 2: Helm itself base64-encodes gzip(json).
    buf = Buffer.from(buf.toString('utf-8'), 'base64');
    // Helm gzips by default (magic 0x1f 0x8b 0x08); older/plain blobs are raw JSON.
    if (buf.length >= 3 &&
        buf[0] === HELM_RELEASE_MAGIC_GZIP[0] &&
        buf[1] === HELM_RELEASE_MAGIC_GZIP[1] &&
        buf[2] === HELM_RELEASE_MAGIC_GZIP[2]) {
      // Bound the inflated size so a hostile blob can't exhaust memory.
      buf = zlib.gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 });
    }
    return JSON.parse(buf.toString('utf-8'));
  } catch (error) {
    log.warn('skipping undecodable helm release secret', { secret: secret?.metadata?.name, namespace: secret?.metadata?.namespace, err: error });
    return null;
  }
};

// List all Helm release Secrets (owner=helm), optionally scoped to a namespace
// and/or a release name, paging through `continue` tokens.
const listHelmReleaseSecrets = async (namespace, name) => {
  const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const labelSelector = name && isLabelValue(name) ? `owner=helm,name=${name}` : 'owner=helm';
  const items = [];
  let _continue;
  for (let page = 0; page < 200; page++) {
    const opts = { labelSelector, limit: 500, _continue };
    const resp = namespace
      ? await core.listNamespacedSecret({ namespace, ...opts })
      : await core.listSecretForAllNamespaces(opts);
    items.push(...(resp.items || []));
    _continue = resp.metadata?._continue;
    if (!_continue) break;
  }
  return items;
};

// Keep only the newest revision per (namespace, release) — chosen from the
// `name`/`version` labels so only ONE secret per release is base64+gunzip
// decoded (secrets without those labels fall back to decoding).
const latestHelmReleases = (secrets) => {
  const newest = new Map(); // ns/name -> secret
  const unlabeled = [];
  for (const s of secrets) {
    const l = s.metadata?.labels || {};
    const ver = Number(l.version);
    if (!l.name || !Number.isFinite(ver)) { unlabeled.push(s); continue; }
    const key = `${s.metadata?.namespace}/${l.name}`;
    const prev = newest.get(key);
    if (!prev || ver > Number(prev.metadata.labels.version)) newest.set(key, s);
  }
  const latest = new Map();
  for (const secret of [...newest.values(), ...unlabeled]) {
    const rel = decodeHelmRelease(secret);
    if (!rel) continue;
    const key = `${rel.namespace}/${rel.name}`;
    const prev = latest.get(key);
    if (!prev || (rel.version || 0) > (prev.version || 0)) {
      latest.set(key, rel);
    }
  }
  return [...latest.values()];
};

// Find the latest revision of one named release (for values/manifest lookups).
const getLatestHelmRelease = async (namespace, name) => {
  const secrets = await listHelmReleaseSecrets(namespace, name);
  const releases = latestHelmReleases(secrets).filter(r => r.name === name);
  return releases[0] || null;
};

app.get('/api/helm/releases', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('helm-releases');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const secrets = await listHelmReleaseSecrets();
    const releases = latestHelmReleases(secrets);

    const result = {
      releases: releases.map(r => {
        const chartMeta = r.chart?.metadata || {};
        return {
          name: r.name,
          namespace: r.namespace,
          revision: String(r.version ?? ''),
          updated: r.info?.last_deployed || r.info?.first_deployed || '',
          status: r.info?.status || '',
          chart: chartMeta.name ? `${chartMeta.name}-${chartMeta.version}` : '',
          appVersion: chartMeta.appVersion || ''
        };
      })
    };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { releases: [] }, 'Failed to list helm releases');
  }
});

app.get('/api/helm/releases/:namespace/:name/values', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const release = await getLatestHelmRelease(namespace, name);
    if (!release) return res.status(404).json({ error: `Release ${name} not found in ${namespace}`, code: 'not_found' });

    // `helm get values` returns the user-supplied values (release.config).
    const values = release.config || {};
    const output = Object.keys(values).length ? yaml.dump(values) : '{}\n';
    res.json({ yaml: output });
  } catch (error) {
    fail(res, error, undefined, 'Failed to get values');
  }
});

app.get('/api/helm/releases/:namespace/:name/manifest', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const release = await getLatestHelmRelease(namespace, name);
    if (!release) return res.status(404).json({ error: `Release ${name} not found in ${namespace}`, code: 'not_found' });

    res.json({ yaml: release.manifest || '' });
  } catch (error) {
    fail(res, error, undefined, 'Failed to get manifest');
  }
});

// CRD index: { name, group, kind, plural, singular, scope, createdAt, version }
// (version = the storage version). Also feeds the REST mapping used by
// delete for custom kinds.
const fetchCrds = async () => {
  const { items } = await kubeConfig.makeApiClient(k8s.ApiextensionsV1Api).listCustomResourceDefinition({}, requestOptions(15000));
  return (items || []).map((c) => ({
    name: c.metadata?.name || '',
    group: c.spec?.group || '',
    kind: c.spec?.names?.kind || '',
    plural: c.spec?.names?.plural || '',
    singular: c.spec?.names?.singular || '',
    scope: c.spec?.scope || '',
    createdAt: c.metadata?.creationTimestamp,
    version: (c.spec?.versions || []).find((v) => v.storage)?.name || '-',
  }));
};
// Cached CRD index for REST-mapping lookups (same TTL/key as /api/customresources).
const crdIndex = async () => {
  const key = getCacheKey('crds');
  const hit = getCache(key);
  if (hit) return hit.crds;
  const crds = await fetchCrds();
  setCache(key, { crds }, CACHE_TTL.namespaces);
  return crds;
};

app.get('/api/customresources', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('crds');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const crds = await fetchCrds();
    const result = { crds };

    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { crds: [] }, 'Failed to list CRDs');
  }
});

app.get('/api/customresources/:group/:version/:plural', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { group, version, plural } = req.params;
    const cacheKey = getCacheKey('cr-instances', { group, version, plural });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // /apis/<group>/<version>/<plural> lists across all namespaces (and is the
    // only form for cluster-scoped kinds).
    const data = await kubeConfig.makeApiClient(k8s.CustomObjectsApi)
      .listClusterCustomObject({ group, version, plural }, requestOptions(20000));
    const items = (data.items || []).map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || '-',
      createdAt: item.metadata.creationTimestamp
    }));

    const result = { items };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { items: [] }, 'Failed to list custom resources');
  }
});

// Full YAML for a single custom-resource instance
app.get('/api/customresource/:group/:version/:plural/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { group, version, plural, name } = req.params;
    const namespace = req.query.namespace !== undefined ? String(req.query.namespace) : undefined;
    if (namespace !== undefined && !isNamespace(namespace)) return bad(res, 'namespace');

    const api = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    const opts = requestOptions(15000);
    const obj = namespace && namespace !== '-' && namespace !== 'all'
      ? await api.getNamespacedCustomObject({ group, version, namespace, plural, name }, opts)
      : await api.getClusterCustomObject({ group, version, plural, name }, opts);
    // `kubectl get -o yaml` hides managedFields; do the same.
    if (obj?.metadata?.managedFields) delete obj.metadata.managedFields;
    res.json({ yaml: yaml.dump(obj, { indent: 2, noRefs: true, lineWidth: -1 }) });
  } catch (error) {
    fail(res, error, undefined, 'Failed to get resource');
  }
});

// ------------------------------------------------------------------
// ArgoCD (GitOps). Detected via the applications.argoproj.io CRD; if present the
// UI shows an ArgoCD view. Applications are plain CRs, so we read them with
// kubectl (context-aware) and parse the sync/health/source/destination fields.
// ------------------------------------------------------------------
// Argo CD objects are CRs in argoproj.io/v1alpha1 → CustomObjectsApi on the
// current context. `argoList(plural)` lists across all namespaces.
const ARGO_API = { group: 'argoproj.io', version: 'v1alpha1' };
const argoApi = () => kubeConfig.makeApiClient(k8s.CustomObjectsApi);
const argoList = async (plural, timeoutMs = 25000) =>
  (await argoApi().listClusterCustomObject({ ...ARGO_API, plural }, requestOptions(timeoutMs))).items || [];
const argoGet = (plural, namespace, name, timeoutMs = 15000) =>
  argoApi().getNamespacedCustomObject({ ...ARGO_API, plural, namespace, name }, requestOptions(timeoutMs));
const argoMergePatch = (plural, namespace, name, body) =>
  argoApi().patchNamespacedCustomObject({ ...ARGO_API, plural, namespace, name, body }, patchOptions(PatchStrategy.MergePatch, 20000));
const isNotFound = (e) => e?.code === 404 || e?.statusCode === 404;

const argoSource = (spec) => spec.source || (Array.isArray(spec.sources) ? spec.sources[0] : {}) || {};
const parseArgoApp = (a) => {
  const spec = a.spec || {}, st = a.status || {};
  const src = argoSource(spec);
  return {
    name: a.metadata?.name,
    namespace: a.metadata?.namespace,
    project: spec.project || 'default',
    syncStatus: st.sync?.status || 'Unknown',
    healthStatus: st.health?.status || 'Unknown',
    healthMessage: st.health?.message || '',
    repoURL: src.repoURL || '',
    path: src.path || src.chart || '',
    targetRevision: src.targetRevision || '',
    revision: (st.sync?.revision || '').slice(0, 7),
    multiSource: Array.isArray(spec.sources) && spec.sources.length > 1,
    destName: spec.destination?.name || '',
    destServer: spec.destination?.server || '',
    destNamespace: spec.destination?.namespace || '',
    resourceCount: (st.resources || []).length,
    operationPhase: st.operationState?.phase || '',
    autoSync: !!spec.syncPolicy?.automated,
    createdAt: a.metadata?.creationTimestamp,
    // extras for the properties panel + dashboard "recent activity"
    reconciledAt: st.reconciledAt || '',
    images: st.summary?.images || [],
    finalizers: a.metadata?.finalizers || [],
    controlledBy: (a.metadata?.ownerReferences || []).find(o => o.kind === 'ApplicationSet')?.name || '',
    lastOperation: st.operationState
      ? { phase: st.operationState.phase || '', message: st.operationState.message || '', finishedAt: st.operationState.finishedAt || st.operationState.startedAt || '' }
      : null,
  };
};

// ------------------------------------------------------------------
// Security Center — surfaces the Trivy Operator's report CRDs (image CVEs,
// config-audit / best-practice checks, and RBAC risk assessment). The operator
// (github.com/aquasecurity/trivy-operator) does the scanning in-cluster; we just
// read and aggregate its reports, so there's nothing extra to install app-side.
// ------------------------------------------------------------------
const TRIVY_GROUP = 'aquasecurity.github.io';
const TRIVY_VER = 'v1alpha1';
const co = () => kubeConfig.makeApiClient(k8s.CustomObjectsApi);

const listTrivy = async (plural, { cluster = false } = {}) => {
  try {
    // client-node 2.0 names the param `plural` on the cluster call but
    // `resourcePlural` on the all-namespaces one.
    const res = cluster
      ? await co().listClusterCustomObject({ group: TRIVY_GROUP, version: TRIVY_VER, plural })
      : await co().listCustomObjectForAllNamespaces({ group: TRIVY_GROUP, version: TRIVY_VER, resourcePlural: plural });
    return res.items || [];
  } catch (e) {
    if (e?.code === 404 || e?.statusCode === 404) return null; // CRD not installed
    throw e;
  }
};

// Trivy labels the report with the scanned resource it belongs to.
const trivyOwner = (r) => {
  const l = r.metadata?.labels || {};
  return {
    kind: l['trivy-operator.resource.kind'] || r.metadata?.ownerReferences?.[0]?.kind || '',
    name: l['trivy-operator.resource.name'] || r.metadata?.ownerReferences?.[0]?.name || r.metadata?.name || '',
    namespace: r.metadata?.namespace || '',
    container: l['trivy-operator.container.name'] || '',
  };
};
const sev = (s) => (s || 'UNKNOWN').toUpperCase();
const emptySummary = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
const sevTotalOf = (s = {}) => (s.CRITICAL || 0) + (s.HIGH || 0) + (s.MEDIUM || 0) + (s.LOW || 0) + (s.UNKNOWN || 0);
const addSummary = (into, s = {}) => {
  into.CRITICAL += s.criticalCount || 0; into.HIGH += s.highCount || 0;
  into.MEDIUM += s.mediumCount || 0; into.LOW += s.lowCount || 0; into.UNKNOWN += s.unknownCount || s.noneCount || 0;
  return into;
};

app.get('/api/security/status', async (req, res) => {
  if (!kubeConfig) return res.json({ installed: false });
  try {
    const api = kubeConfig.makeApiClient(k8s.ApiextensionsV1Api);
    const { items } = await api.listCustomResourceDefinition();
    const names = new Set(items.map((c) => c.metadata?.name));
    const has = (n) => names.has(`${n}.${TRIVY_GROUP}`);
    const installed = [...names].some((n) => n?.endsWith(`.${TRIVY_GROUP}`));
    res.json({
      installed,
      reports: {
        vulnerability: has('vulnerabilityreports'),
        configAudit: has('configauditreports'),
        rbac: has('rbacassessmentreports') || has('clusterrbacassessmentreports'),
        exposedSecret: has('exposedsecretreports'),
      },
    });
  } catch (e) {
    res.json({ installed: false, error: firstLine(e.message) });
  }
});

// Image vulnerability reports → grouped by image, with severity + CVE detail.
app.get('/api/security/vulnerabilities', async (req, res) => {
  try {
    const items = await listTrivy('vulnerabilityreports');
    if (items === null) return res.json({ installed: false, images: [], summary: emptySummary() });
    const ns = req.query.namespace && req.query.namespace !== 'all' ? req.query.namespace : null;
    const total = emptySummary();
    const byImage = new Map();
    for (const r of items) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace !== ns) continue;
      const rep = r.report || {};
      const art = rep.artifact || {};
      const reg = rep.registry?.server || '';
      const image = `${reg ? reg + '/' : ''}${art.repository || '?'}${art.tag ? ':' + art.tag : (art.digest ? '@' + String(art.digest).slice(0, 19) : '')}`;
      addSummary(total, rep.summary);
      const scannedAt = rep.updateTimestamp || r.metadata?.creationTimestamp || '';
      if (!byImage.has(image)) byImage.set(image, {
        image, repository: art.repository || '', tag: art.tag || '',
        digest: art.digest || '', registry: reg,
        os: `${rep.os?.family || ''} ${rep.os?.name || ''}`.trim(),
        namespace: owner.namespace, status: 'Scanned',
        scanner: [rep.scanner?.name, rep.scanner?.version].filter(Boolean).join(' '),
        scannedAt, summary: emptySummary(), workloads: [], vulnerabilities: [], secrets: 0, _seen: new Set(),
      });
      const g = byImage.get(image);
      if (scannedAt > g.scannedAt) g.scannedAt = scannedAt;
      addSummary(g.summary, rep.summary);
      g.workloads.push({ kind: owner.kind, name: owner.name, namespace: owner.namespace, container: owner.container });
      for (const v of (rep.vulnerabilities || [])) {
        const key = v.vulnerabilityID + '|' + v.resource + '|' + v.installedVersion;
        if (g._seen.has(key)) continue; g._seen.add(key);
        g.vulnerabilities.push({
          id: v.vulnerabilityID, severity: sev(v.severity), pkg: v.resource || '',
          installedVersion: v.installedVersion || '', fixedVersion: v.fixedVersion || '',
          title: v.title || '', link: v.primaryLink || (v.links || [])[0] || '', score: v.score,
        });
      }
    }
    // Merge exposed-secret counts (a separate Trivy Operator report) by image.
    const secretItems = await listTrivy('exposedsecretreports');
    for (const r of (secretItems || [])) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace !== ns) continue;
      const rep = r.report || {};
      const art = rep.artifact || {};
      const reg = rep.registry?.server || '';
      const image = `${reg ? reg + '/' : ''}${art.repository || '?'}${art.tag ? ':' + art.tag : (art.digest ? '@' + String(art.digest).slice(0, 19) : '')}`;
      const g = byImage.get(image);
      if (g) g.secrets = (g.secrets || 0) + (rep.summary ? sevTotalOf({ CRITICAL: rep.summary.criticalCount, HIGH: rep.summary.highCount, MEDIUM: rep.summary.mediumCount, LOW: rep.summary.lowCount }) : (rep.secrets || []).length);
    }

    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
    const images = [...byImage.values()].map((g) => {
      delete g._seen;
      g.platform = g.platform || g.os;
      g.criticalCount = g.summary.CRITICAL;
      g.vulnerabilities.sort((a, b) => order[a.severity] - order[b.severity] || (b.score || 0) - (a.score || 0));
      return g;
    }).sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
    // Results donut: images with any finding vs clean.
    const vulnerable = images.filter((g) => sevTotalOf(g.summary) > 0).length;
    const results = { vulnerable, ok: images.length - vulnerable };
    // Status donut: scanned vs not-scanned (best-effort pod count for the total).
    const scanned = images.length;
    let podCount = null;
    try {
      const pods = await kubeConfig.makeApiClient(k8s.CoreV1Api).listPodForAllNamespaces({ limit: 5000 });
      podCount = (pods.items || []).length;
    } catch { /* best-effort */ }
    res.json({
      installed: true, images, summary: total, reportCount: items.length,
      results, scanned, notScanned: podCount != null ? Math.max(0, podCount - scanned) : null,
    });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// Config-audit (resource best-practice) + RBAC assessment reports. `kind` picks
// which: 'config' (configauditreports) or 'rbac' (rbac + cluster rbac).
app.get('/api/security/checks', async (req, res) => {
  try {
    const which = req.query.kind === 'rbac' ? 'rbac' : 'config';
    let items;
    if (which === 'config') {
      items = await listTrivy('configauditreports');
      if (items === null) return res.json({ installed: false, resources: [], summary: emptySummary() });
    } else {
      const nsR = await listTrivy('rbacassessmentreports');
      const clR = await listTrivy('clusterrbacassessmentreports', { cluster: true });
      if (nsR === null && clR === null) return res.json({ installed: false, resources: [], summary: emptySummary() });
      items = [...(nsR || []), ...(clR || [])];
    }
    const ns = req.query.namespace && req.query.namespace !== 'all' ? req.query.namespace : null;
    const total = emptySummary();
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
    const resources = [];
    for (const r of items) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace && owner.namespace !== ns) continue;
      const rep = r.report || {};
      addSummary(total, rep.summary);
      const failed = (rep.checks || []).filter((c) => c.success === false).map((c) => ({
        id: c.checkID || c.id || '', title: c.title || '', severity: sev(c.severity),
        category: c.category || '', message: (c.messages || [])[0] || c.description || '', remediation: c.remediation || '',
      })).sort((a, b) => order[a.severity] - order[b.severity]);
      if (!failed.length) continue;
      resources.push({
        kind: owner.kind || 'Cluster', name: owner.name, namespace: owner.namespace,
        createdAt: r.metadata?.creationTimestamp || '',
        scannedAt: rep.updateTimestamp || r.metadata?.creationTimestamp || '',
        scanner: [rep.scanner?.name, rep.scanner?.version].filter(Boolean).join(' '),
        labels: Object.keys(r.metadata?.labels || {}).length,
        summary: rep.summary && {
          CRITICAL: rep.summary.criticalCount || 0, HIGH: rep.summary.highCount || 0, MEDIUM: rep.summary.mediumCount || 0, LOW: rep.summary.lowCount || 0, UNKNOWN: 0,
        } || emptySummary(),
        checks: failed,
      });
    }
    resources.sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
    res.json({ installed: true, resources, summary: total, reportCount: items.length });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// ---- Built-in image scanning (bundled Trivy, no in-cluster operator) ----
// trivy-scan.js keeps per-context state (getScanState) and persists results
// (loadScan, async). The fallbacks cover the older single-state export.
const scanStateFor = (ctx) => (typeof trivyScan.getScanState === 'function' ? trivyScan.getScanState(ctx) : trivyScan.scanState) || {};
// eslint-disable-next-line no-control-regex -- intentionally matching control characters
const hasControlChars = (s) => /[ -]/.test(s);
const loadScanFor = async (ctx) => { try { return await trivyScan.loadScan(ctx); } catch { return null; } };
const scanResultShape = (s = scanStateFor(currentContext)) => {
  return {
    running: s.running, done: s.done, phase: s.phase, total: s.total, scanned: s.scanned,
    startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error,
    installed: !!s.images, images: s.images || [], summary: s.summary,
    results: s.results,
    notScanned: s.total ? Math.max(0, s.total - s.scanned) : null,
    source: 'trivy-builtin',
  };
};

app.get('/api/security/scan/status', async (req, res) => {
  try {
    const t = await trivyScan.trivyAvailable();
    const s = scanStateFor(currentContext);
    const live = (!s.context || s.context === currentContext) && !!s.images;
    const hasResult = live || !!(await loadScanFor(currentContext));
    res.json({ ...t, running: !!s.running, done: !!s.done, hasResult });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/security/scan', async (req, res) => {
  if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
  try {
    const t = await trivyScan.trivyAvailable();
    if (!t.available && !t.installable) return res.status(400).json({ error: 'trivy is not available and cannot be auto-installed on this platform.' });
    if (scanStateFor(currentContext).running) return res.json({ started: false, ...scanResultShape() });
    const ns = req.body?.namespace;
    if (ns != null && ns !== '' && ns !== 'all' && !isDnsLabel(ns)) return bad(res, 'namespace');
    const pods = await kubeConfig.makeApiClient(k8s.CoreV1Api).listPodForAllNamespaces({ limit: 5000 });
    const byImage = trivyScan.listClusterImages(pods.items || [], ns);
    await trivyScan.startScan(byImage, currentContext);
    res.json({ started: true, ...scanResultShape() });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/security/scan', async (req, res) => {
  try {
    const s = scanStateFor(currentContext);
    // Live/in-memory scan for the current context wins; otherwise fall back to the
    // persisted result for this cluster (survives an app restart / context switch).
    if ((!s.context || s.context === currentContext) && (s.images || s.running)) return res.json(scanResultShape(s));
    const cached = await loadScanFor(currentContext);
    if (cached && cached.images?.length) {
      return res.json({
        installed: true, running: false, done: true, phase: 'done', cached: true, source: 'trivy-builtin',
        images: cached.images, summary: cached.summary, results: cached.results,
        scanned: cached.scanned, total: cached.total, notScanned: null, finishedAt: cached.finishedAt,
      });
    }
    res.json(scanResultShape(s));
  } catch (e) {
    fail(res, e);
  }
});

// Applications that aren't fully Synced+Healthy — the "Needs attention" panel.
// eslint-disable-next-line no-unused-vars -- kept for parity with the client "Needs attention" panel
const needsAttention = (a) => a.syncStatus !== 'Synced' || (a.healthStatus !== 'Healthy' && a.healthStatus !== 'Unknown');

// Is ArgoCD installed on the current cluster? (cached briefly)
app.get('/api/argocd/status', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-status', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    let installed = false;
    try {
      await kubeConfig.makeApiClient(k8s.ApiextensionsV1Api)
        .readCustomResourceDefinition({ name: 'applications.argoproj.io' }, requestOptions(12000));
      installed = true;
    } catch { installed = false; }
    // Best-effort: the external Argo CD UI URL (from the argocd-cm configmap).
    let url = '';
    if (installed) {
      try {
        const cm = await kubeConfig.makeApiClient(k8s.CoreV1Api)
          .readNamespacedConfigMap({ name: 'argocd-cm', namespace: 'argocd' }, requestOptions(8000));
        url = String(cm.data?.url || '').trim();
      } catch { /* no argocd-cm / different namespace — button just hidden */ }
    }
    const result = { installed, url };
    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

// List all ArgoCD Applications (parsed summary)
app.get('/api/argocd/applications', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-apps', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const items = (await argoList('applications')).map(parseArgoApp);
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { applications: items };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    fail(res, error, { applications: [] }, 'Failed to list applications');
  }
});

// Run async tasks with bounded concurrency (order of results preserved).
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

// Best-effort health for a live child resource (Argo CD computes these too).
function liveChildHealth(kind, item) {
  if (kind === 'Pod') {
    const phase = item.status?.phase;
    if (phase === 'Succeeded') return { status: 'Healthy' };
    if (phase === 'Failed') return { status: 'Degraded', message: item.status?.reason || '' };
    const cs = item.status?.containerStatuses || [];
    const bad = cs.map(c => c.state?.waiting?.reason).find(r => /CrashLoopBackOff|Error|ImagePullBackOff|ErrImagePull|CreateContainerError|RunContainerError/.test(r || ''));
    if (bad) return { status: 'Degraded', message: bad };
    const ready = (item.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True';
    if (phase === 'Running' && ready) return { status: 'Healthy' };
    return { status: 'Progressing' };
  }
  if (kind === 'ReplicaSet') {
    const desired = item.spec?.replicas || 0, ready = item.status?.readyReplicas || 0;
    return { status: ready >= desired ? 'Healthy' : 'Progressing' };
  }
  if (kind === 'Job') {
    if (item.status?.succeeded) return { status: 'Healthy' };
    if (item.status?.failed) return { status: 'Degraded' };
    return { status: 'Progressing' };
  }
  return { status: 'Healthy' };
}

// One Application in full (summary + managed resources + conditions + last op)
app.get('/api/argocd/application/:namespace/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const a = await argoGet('applications', namespace, name);
    const spec = a.spec || {}, st = a.status || {};
    const keyOf = (kind, ns, nm) => `${kind}|${ns || ''}|${nm}`;
    const resources = (st.resources || []).map(r => ({
      group: r.group || '', version: r.version || '', kind: r.kind,
      namespace: r.namespace || '', name: r.name,
      syncStatus: r.status || 'Unknown',
      healthStatus: r.health?.status || '',
      healthMessage: r.health?.message || '',
      parentKey: null, managed: true, createdAt: '',
    }));

    // ---- augment with live descendants (Deployment→RS→Pod, Service→EndpointSlice,
    // CronJob→Job→Pod) by walking ownerReferences, so the tree matches Argo CD ----
    try {
      const nsSet = new Set(resources.map(r => r.namespace).filter(Boolean));
      if (spec.destination?.namespace) nsSet.add(spec.destination.namespace);
      const namespaces = [...nsSet].filter(isDnsLabel).slice(0, 12);
      const LIVE_LISTS = [
        ['Pod', 'CoreV1Api', 'listNamespacedPod'], ['ReplicaSet', 'AppsV1Api', 'listNamespacedReplicaSet'],
        ['EndpointSlice', 'DiscoveryV1Api', 'listNamespacedEndpointSlice'], ['Job', 'BatchV1Api', 'listNamespacedJob'],
      ];
      const live = [];
      // Four typed lists per namespace, at most 4 namespaces in flight.
      await mapLimit(namespaces, 4, async (ns) => {
        const opts = requestOptions(15000);
        await Promise.all(LIVE_LISTS.map(async ([kind, api, method]) => {
          try {
            const out = await kubeConfig.makeApiClient(k8s[api])[method]({ namespace: ns }, opts);
            for (const it of (out.items || [])) live.push({ item: it, kind, ns });
          } catch { /* best-effort per namespace/kind (RBAC etc.) */ }
        }));
      });

      const nodeByKey = new Map();
      resources.forEach(r => nodeByKey.set(keyOf(r.kind, r.namespace, r.name), r));
      const remaining = live.slice();
      let added = true, pass = 0;
      while (added && pass < 5) {
        added = false; pass++;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const { item, kind, ns } = remaining[i];
          const nm = item.metadata?.name;
          if (!nm) { remaining.splice(i, 1); continue; }
          const key = keyOf(kind, ns, nm);
          if (nodeByKey.has(key)) { remaining.splice(i, 1); continue; }
          if (kind === 'ReplicaSet' && !(item.spec?.replicas || item.status?.replicas)) { remaining.splice(i, 1); continue; } // drop scaled-down history
          let parentKey = null;
          for (const o of (item.metadata?.ownerReferences || [])) {
            const k = keyOf(o.kind, ns, o.name);
            if (nodeByKey.has(k)) { parentKey = k; break; }
          }
          if (!parentKey && kind === 'EndpointSlice') {
            const svc = item.metadata?.labels?.['kubernetes.io/service-name'];
            if (svc && nodeByKey.has(keyOf('Service', ns, svc))) parentKey = keyOf('Service', ns, svc);
          }
          if (!parentKey) continue;
          const h = liveChildHealth(kind, item);
          const node = {
            group: (item.apiVersion || '').includes('/') ? item.apiVersion.split('/')[0] : '',
            version: '', kind, namespace: ns, name: nm,
            syncStatus: '', healthStatus: h.status, healthMessage: h.message || '',
            parentKey, managed: false, createdAt: item.metadata?.creationTimestamp || '',
          };
          nodeByKey.set(key, node); resources.push(node); remaining.splice(i, 1); added = true;
        }
      }
    } catch { /* live-tree augmentation is best-effort */ }
    // events on the Application object (sync started/completed, health changes, …)
    let events = [];
    try {
      const ev = await kubeConfig.makeApiClient(k8s.CoreV1Api).listNamespacedEvent(
        { namespace, fieldSelector: `involvedObject.name=${name},involvedObject.kind=Application` }, requestOptions(10000));
      events = (ev.items || [])
        .map(e => ({ type: e.type, reason: e.reason, message: e.message, count: e.count, lastTimestamp: eventTime(e) }))
        .sort((x, y) => new Date(y.lastTimestamp) - new Date(x.lastTimestamp))
        .slice(0, 20);
    } catch { /* events are best-effort */ }
    res.json({
      app: parseArgoApp(a),
      sources: spec.sources || (spec.source ? [spec.source] : []),
      destination: spec.destination || {},
      syncPolicy: spec.syncPolicy || {},
      resources,
      conditions: st.conditions || [],
      operationState: st.operationState
        ? { phase: st.operationState.phase, message: st.operationState.message, startedAt: st.operationState.startedAt, finishedAt: st.operationState.finishedAt, revision: (st.operationState.syncResult?.revision || '').slice(0, 7) }
        : null,
      history: (st.history || []).map(h => ({ id: h.id, revision: h.revision, deployedAt: h.deployedAt })).reverse(),
      events,
    });
  } catch (error) {
    fail(res, error, undefined, 'Failed to get application');
  }
});

// Trigger a sync of an Application. Body accepts options:
// { prune, dryRun, applyOnly, force, replace, revision }
app.post('/api/argocd/application/:namespace/:name/sync', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const o = req.body || {};
    if (o.revision != null && o.revision !== '') {
      if (typeof o.revision !== 'string' || o.revision.length > 256 || hasControlChars(o.revision)) return bad(res, 'revision');
    }
    // Merge-patch `.operation` on the Application (what `argocd app sync` does).
    await argoMergePatch('applications', namespace, name, argoSyncPatch(o));
    cache.clear();
    res.json({ success: true, message: `application.argoproj.io/${name} patched` });
  } catch (error) {
    fail(res, error);
  }
});

// Delete an Application. ?cascade=false removes the argocd finalizer first so
// the managed resources are left in place (orphan); default cascades.
app.delete('/api/argocd/application/:namespace/:name', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const cascade = req.query.cascade !== 'false';
    if (!cascade) {
      // drop the finalizer so deletion doesn't cascade to the managed resources
      await argoMergePatch('applications', namespace, name, dropFinalizersPatch());
    }
    await argoApi().deleteNamespacedCustomObject(
      { ...ARGO_API, plural: 'applications', namespace, name, body: { propagationPolicy: 'Background' } }, requestOptions(30000));
    cache.clear();
    res.json({ success: true, message: `application.argoproj.io "${name}" deleted` });
  } catch (error) {
    fail(res, error);
  }
});

// List AppProjects
app.get('/api/argocd/projects', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-projects', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const projects = (await argoList('appprojects', 20000)).map(p => {
      const s = p.spec || {};
      return {
        name: p.metadata?.name, namespace: p.metadata?.namespace,
        description: s.description || '',
        sourceRepos: s.sourceRepos || [],
        destinations: (s.destinations || []).map(d => `${d.server || d.name || '*'}/${d.namespace || '*'}`),
        clusterResourceWhitelist: (s.clusterResourceWhitelist || []).length,
        roles: (s.roles || []).map(r => r.name),
        createdAt: p.metadata?.creationTimestamp,
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { projects };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    fail(res, error, { projects: [] }, 'Failed to list projects');
  }
});

// List ApplicationSets (may be absent — controller not installed)
app.get('/api/argocd/applicationsets', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-appsets', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    let available = true, appSets = [];
    try {
      appSets = (await argoList('applicationsets', 20000)).map(as => {
        const s = as.spec || {}, st = as.status || {};
        return {
          name: as.metadata?.name, namespace: as.metadata?.namespace,
          generators: (s.generators || []).map(g => Object.keys(g)[0]).filter(Boolean),
          destinationNamespace: s.template?.spec?.destination?.namespace || '',
          project: s.template?.spec?.project || '',
          conditions: (st.conditions || []).map(c => ({ type: c.type, status: c.status, message: c.message })),
          createdAt: as.metadata?.creationTimestamp,
        };
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) {
      if (isNotFound(e)) available = false; // ApplicationSet CRD / controller not installed
      else throw e;
    }
    const result = { available, applicationSets: appSets };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    fail(res, error, { applicationSets: [] }, 'Failed to list application sets');
  }
});

const b64 = (v) => { try { return Buffer.from(v || '', 'base64').toString('utf-8'); } catch { return ''; } };

// Repositories ArgoCD is wired to. Repos may be stored as secrets, or configured
// inline in Applications — so we merge repo secrets with the distinct repoURLs
// actually referenced by Applications.
app.get('/api/argocd/repositories', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-repos', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const byUrl = new Map();
    try {
      const data = await kubeConfig.makeApiClient(k8s.CoreV1Api)
        .listSecretForAllNamespaces({ labelSelector: 'argocd.argoproj.io/secret-type=repository' }, requestOptions(15000));
      for (const s of data.items || []) {
        const d = s.data || {};
        const url = b64(d.url);
        if (url) byUrl.set(url, { url, name: b64(d.name), type: b64(d.type) || 'git', project: b64(d.project) || '', source: 'secret' });
      }
    } catch { /* fall through to app-derived */ }
    // derive from applications
    try {
      for (const a of await argoList('applications')) {
        const spec = a.spec || {};
        const srcs = spec.sources || (spec.source ? [spec.source] : []);
        for (const s of srcs) {
          const url = s.repoURL;
          if (!url) continue;
          if (!byUrl.has(url)) byUrl.set(url, { url, name: '', type: s.chart ? 'helm' : 'git', project: '', source: 'application', appCount: 0 });
          const r = byUrl.get(url); r.appCount = (r.appCount || 0) + 1;
        }
      }
    } catch { /* best-effort */ }
    const repositories = [...byUrl.values()].sort((a, b) => (a.url || '').localeCompare(b.url || ''));
    const result = { repositories };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    fail(res, error, { repositories: [] }, 'Failed to list repositories');
  }
});

// Clusters ArgoCD manages (stored as secrets; plus the implicit in-cluster).
app.get('/api/argocd/clusters', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-clusters', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const clusters = [];
    try {
      const data = await kubeConfig.makeApiClient(k8s.CoreV1Api)
        .listSecretForAllNamespaces({ labelSelector: 'argocd.argoproj.io/secret-type=cluster' }, requestOptions(15000));
      for (const s of data.items || []) {
        const d = s.data || {};
        clusters.push({ name: b64(d.name), server: b64(d.server) });
      }
    } catch { /* best-effort */ }
    clusters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { clusters };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    fail(res, error, { clusters: [] }, 'Failed to list clusters');
  }
});

// Refresh an Application (re-compares against git without syncing)
app.post('/api/argocd/application/:namespace/:name/refresh', mcpWriteGate, async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    // Same as `kubectl annotate --overwrite … argocd.argoproj.io/refresh=hard|normal`.
    await argoMergePatch('applications', namespace, name, argoRefreshPatch(!!req.body?.hard));
    cache.clear();
    res.json({ success: true, message: `application.argoproj.io/${name} annotated` });
  } catch (error) {
    fail(res, error);
  }
});

const parseCpuCores = (s) => {
  if (!s || s === '-') return 0;
  if (String(s).endsWith('m')) return parseInt(s) / 1000;
  return parseFloat(s) || 0;
};

// returns bytes
const parseMemBytes = (s) => {
  if (!s || s === '-') return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i)?$/);
  if (!m) return parseFloat(s) || 0;
  const val = parseFloat(m[1]);
  const unit = m[2];
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  return val * (mult[unit] || 1);
};

app.get('/api/cluster/summary', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = getCacheKey('cluster-summary');
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }
    const errors = [];

    // Kubernetes version — read it in-process via the API server's /version
    // endpoint instead of shelling out to `kubectl version`, which prints a
    // "client/server version skew" warning when the local kubectl binary is more
    // than one minor off the cluster, and needs a matching kubectl at all.
    let serverVersion = 'unknown';
    let platform = '';
    try {
      const info = await kubeConfig.makeApiClient(k8s.VersionApi).getCode();
      serverVersion = info.gitVersion || 'unknown';
      platform = info.platform || '';
    } catch (e) { /* version is best-effort */ }

    // Nodes (reuse existing helpers)
    let nodes = [];
    try { nodes = (await fetchNodes()).map(formatNode); }
    catch (e) { errors.push({ kind: 'nodes', error: firstLine(e.body?.message || e.message) }); }
    const nodeSummary = {
      total: nodes.length,
      ready: nodes.filter(n => n.status === 'Ready').length,
      notReady: nodes.filter(n => n.status !== 'Ready').length
    };

    const roles = {};
    let cpuCapacity = 0, cpuAllocatable = 0, memCapacity = 0, memAllocatable = 0;
    const versions = new Set();
    const osImages = new Set();
    for (const n of nodes) {
      String(n.roles || 'worker').split(',').map(r => r.trim()).filter(Boolean).forEach(r => {
        roles[r] = (roles[r] || 0) + 1;
      });
      cpuCapacity += parseCpuCores(n.cpuCapacity);
      cpuAllocatable += parseCpuCores(n.cpuAllocatable);
      memCapacity += parseMemBytes(n.memoryCapacity);
      memAllocatable += parseMemBytes(n.memoryAllocatable);
      if (n.version) versions.add(n.version);
      if (n.os) osImages.add(n.os);
    }

    // Pod phases
    const podPhases = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
    let podTotal = 0;
    try {
      // Page through all pods (500 at a time) so a large cluster never needs
      // one giant response just to count phases.
      const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
      let _continue;
      for (let page = 0; page < 200; page++) {
        const resp = await core.listPodForAllNamespaces({ limit: 500, _continue }, requestOptions(12000));
        for (const pod of resp.items || []) {
          const p = pod.status?.phase || 'Unknown';
          podPhases[p] = (podPhases[p] || 0) + 1;
          podTotal++;
        }
        _continue = resp.metadata?._continue;
        if (!_continue) break;
      }
    } catch (e) { errors.push({ kind: 'pods', error: firstLine(e.body?.message || e.message) }); }

    // Namespace count
    let namespaceCount = 0;
    try {
      const resp = await kubeConfig.makeApiClient(k8s.CoreV1Api).listNamespace({}, requestOptions(8000));
      namespaceCount = (resp.items || []).length;
    } catch (e) { errors.push({ kind: 'namespaces', error: firstLine(e.body?.message || e.message) }); }

    // Everything failed → the cluster is unreachable/unauthorized: report it.
    if (errors.length === 3) return res.status(502).json({ error: errors[0].error, code: 'upstream_error', errors });

    const result = {
      currentContext: currentContext,
      serverVersion,
      platform,
      contexts: kubeConfig.contexts.map(c => c.name),
      clusters: kubeConfig.clusters.map(c => c.name),
      nodes: nodeSummary,
      roles,
      capacity: {
        cpuCapacity: +cpuCapacity.toFixed(1),
        cpuAllocatable: +cpuAllocatable.toFixed(1),
        memCapacityBytes: memCapacity,
        memAllocatableBytes: memAllocatable
      },
      versions: Array.from(versions),
      osImages: Array.from(osImages),
      pods: { total: podTotal, phases: podPhases },
      namespaceCount
    };
    if (errors.length) { result.partial = true; result.errors = errors; }

    setCache(cacheKey, result, errors.length ? 5000 : CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

const parseCpuMilli = (s) => {
  if (!s) return 0;
  s = String(s);
  if (s.endsWith('n')) return parseFloat(s) / 1e6;   // nanocores
  if (s.endsWith('u')) return parseFloat(s) / 1e3;   // microcores
  if (s.endsWith('m')) return parseFloat(s);         // millicores
  return parseFloat(s) * 1000;                        // cores
};

// metrics.k8s.io/v1beta1 (metrics-server) read as custom objects on the
// current context. A 404 (API not installed) is handled by the callers as
// `available: false`. Names are validated before they get here.
const METRICS_API = { group: 'metrics.k8s.io', version: 'v1beta1' };
const fetchMetrics = ({ plural, namespace, name }) => {
  const api = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
  const opts = requestOptions(10000);
  if (name && namespace) return api.getNamespacedCustomObject({ ...METRICS_API, namespace, plural, name }, opts);
  if (name) return api.getClusterCustomObject({ ...METRICS_API, plural, name }, opts);
  if (namespace) return api.listNamespacedCustomObject({ ...METRICS_API, namespace, plural }, opts);
  return api.listClusterCustomObject({ ...METRICS_API, plural }, opts);
};

const summarizePodMetrics = (item) => {
  let cpuMilli = 0;
  let memBytes = 0;
  const containers = (item.containers || []).map(c => {
    const cm = parseCpuMilli(c.usage?.cpu);
    const mb = parseMemBytes(c.usage?.memory);
    cpuMilli += cm;
    memBytes += mb;
    return { name: c.name, cpuMilli: +cm.toFixed(1), memBytes: mb };
  });
  return {
    cpuMilli: +cpuMilli.toFixed(1),
    memBytes,
    containers,
    timestamp: item.timestamp,
    window: item.window
  };
};

// Metrics for all pods (optionally scoped to a namespace) — keyed by "namespace/name"
app.get('/api/metrics/pods/:namespace?', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace } = req.params;
    const cacheKey = getCacheKey('metrics-pods', { namespace: namespace || 'all' });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const scoped = namespace && namespace !== 'all' && namespace !== '-' ? namespace : undefined;

    let data;
    try {
      data = await fetchMetrics({ plural: 'pods', namespace: scoped });
    } catch (err) {
      return res.json({ metrics: {}, available: false });
    }

    const metrics = {};
    (data.items || []).forEach(item => {
      const key = `${item.metadata.namespace}/${item.metadata.name}`;
      metrics[key] = summarizePodMetrics(item);
    });

    const result = { metrics, available: true };
    setCache(cacheKey, result, 8000);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { metrics: {} });
  }
});

// Metrics for a single pod (used for live polling in the detail drawer)
app.get('/api/metrics/pod/:namespace/:pod', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, pod } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');

    let item;
    try {
      item = await fetchMetrics({ plural: 'pods', namespace, name: pod });
    } catch (err) {
      return res.json({ available: false });
    }

    res.json({ available: true, ...summarizePodMetrics(item) });
  } catch (error) {
    fail(res, error);
  }
});

// Live metrics + capacity for a single node (for node detail graphs)
app.get('/api/metrics/node/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { name } = req.params;
    if (!isDnsSubdomain(name)) return bad(res, 'name');

    let usage;
    try {
      const m = await fetchMetrics({ plural: 'nodes', name });
      usage = m.usage || {};
    } catch (err) {
      return res.json({ available: false });
    }

    let cpuCap = '0', memCap = '0', cpuAlloc = '0', memAlloc = '0';
    try {
      const node = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNode({ name }, requestOptions(8000));
      cpuCap = node.status?.capacity?.cpu || '0';
      memCap = node.status?.capacity?.memory || '0';
      cpuAlloc = node.status?.allocatable?.cpu || '0';
      memAlloc = node.status?.allocatable?.memory || '0';
    } catch (e) { /* capacity is best-effort */ }

    res.json({
      available: true,
      cpuMilli: +parseCpuMilli(usage.cpu).toFixed(1),
      memBytes: parseMemBytes(usage.memory),
      cpuCapacityMilli: parseCpuMilli(cpuCap),
      memCapacityBytes: parseMemBytes(memCap),
      cpuAllocatableMilli: parseCpuMilli(cpuAlloc),
      memAllocatableBytes: parseMemBytes(memAlloc)
    });
  } catch (error) {
    fail(res, error);
  }
});

// The typed list calls behind the topology view. List items come back without
// `kind` (the API omits it on list items; kubectl used to fill it in), so each
// item is tagged with the kind it was listed as.
const TOPOLOGY_LISTS = [
  ['Deployment', 'AppsV1Api', 'listNamespacedDeployment'], ['ReplicaSet', 'AppsV1Api', 'listNamespacedReplicaSet'],
  ['StatefulSet', 'AppsV1Api', 'listNamespacedStatefulSet'], ['DaemonSet', 'AppsV1Api', 'listNamespacedDaemonSet'],
  ['Job', 'BatchV1Api', 'listNamespacedJob'], ['CronJob', 'BatchV1Api', 'listNamespacedCronJob'],
  ['Pod', 'CoreV1Api', 'listNamespacedPod'], ['Service', 'CoreV1Api', 'listNamespacedService'],
  ['Ingress', 'NetworkingV1Api', 'listNamespacedIngress'], ['NetworkPolicy', 'NetworkingV1Api', 'listNamespacedNetworkPolicy'],
  ['ConfigMap', 'CoreV1Api', 'listNamespacedConfigMap'], ['Secret', 'CoreV1Api', 'listNamespacedSecret'],
  ['ServiceAccount', 'CoreV1Api', 'listNamespacedServiceAccount'], ['PersistentVolumeClaim', 'CoreV1Api', 'listNamespacedPersistentVolumeClaim'],
  ['Role', 'RbacAuthorizationV1Api', 'listNamespacedRole'], ['RoleBinding', 'RbacAuthorizationV1Api', 'listNamespacedRoleBinding'],
];
const tagKind = (items, kind) => (items || []).map((it) => Object.assign(it, { kind }));
const listTopologyItems = async (namespace) => {
  const opts = requestOptions(25000);
  const settled = await Promise.allSettled(TOPOLOGY_LISTS.map(([kind, api, method]) =>
    kubeConfig.makeApiClient(k8s[api])[method]({ namespace }, opts).then((r) => tagKind(r.items, kind))));
  const failures = settled.filter((s) => s.status === 'rejected');
  if (failures.length === settled.length) throw failures[0].reason;
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
};

app.get('/api/topology/:namespace', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace } = req.params;
    if (!isDnsLabel(namespace)) return bad(res, 'namespace');
    const cacheKey = getCacheKey('topology', { namespace });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // Namespaced resources across workloads / network / storage / config / rbac
    // — one typed list per kind, in parallel. A kind that fails (RBAC) is
    // skipped; every kind failing is a real error.
    let items;
    try {
      items = await listTopologyItems(namespace);
    } catch (err) {
      return fail(res, err, { nodes: [], edges: [] }, 'Failed to build topology');
    }
    const byKind = {};
    for (const it of items) {
      if (it.kind) (byKind[it.kind] = byKind[it.kind] || []).push(it);
    }
    const get = (k) => byKind[k] || [];

    const CATEGORY = {
      Deployment: 'workload', ReplicaSet: 'workload', StatefulSet: 'workload',
      DaemonSet: 'workload', Job: 'workload', CronJob: 'workload', Pod: 'workload',
      Service: 'network', Ingress: 'network', NetworkPolicy: 'network',
      PersistentVolumeClaim: 'storage', PersistentVolume: 'storage', StorageClass: 'storage',
      ConfigMap: 'config', Secret: 'config',
      ServiceAccount: 'rbac', Role: 'rbac', ClusterRole: 'rbac', RoleBinding: 'rbac'
    };

    const workloadStatus = (item) => {
      const s = item.status || {};
      const spec = item.spec || {};
      const kind = item.kind;
      if (kind === 'Pod') return s.phase || 'Unknown';
      if (kind === 'PersistentVolumeClaim' || kind === 'PersistentVolume') return s.phase || 'Unknown';
      if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(kind)) {
        const desired = spec.replicas != null ? spec.replicas
          : (s.desiredNumberScheduled != null ? s.desiredNumberScheduled : null);
        const ready = s.readyReplicas != null ? s.readyReplicas
          : (s.numberReady != null ? s.numberReady : (s.succeeded != null ? s.succeeded : 0));
        if (desired == null) return 'Ready';
        return ready >= desired && desired > 0 ? 'Ready' : (ready === 0 && desired === 0 ? 'Ready' : 'Pending');
      }
      return 'Active';
    };

    const idFor = (kind, name) => `${kind}/${name}`;
    const nodes = [];
    const nodeIndex = new Map();
    const edges = [];
    const rawByKind = new Map(items.map(it => [idFor(it.kind, it.metadata?.name), it]));

    const addNode = (kind, name, extra = {}) => {
      if (!kind || !name) return null;
      const id = idFor(kind, name);
      if (!nodeIndex.has(id)) {
        const item = rawByKind.get(id);
        const node = {
          id, kind, name,
          category: CATEGORY[kind] || 'workload',
          ...extra,
          status: item ? workloadStatus(item) : (extra.status || 'Active')
        };
        nodeIndex.set(id, node);
        nodes.push(node);
      }
      return id;
    };
    const addEdge = (source, target, type) => {
      if (source && target) edges.push({ source, target, type });
    };

    // ---- workloads + pods (always shown) ----
    const WORKLOAD_KINDS = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'];
    for (const kind of WORKLOAD_KINDS) {
      for (const item of get(kind)) {
        const id = addNode(kind, item.metadata.name);
        for (const owner of item.metadata?.ownerReferences || []) {
          addEdge(idFor(owner.kind, owner.name), id, 'owns');
        }
      }
    }

    const pods = get('Pod');

    // ---- network: services, ingresses, network policies ----
    for (const svc of get('Service')) {
      const svcId = addNode('Service', svc.metadata.name);
      const selector = svc.spec?.selector;
      if (selector && Object.keys(selector).length) {
        for (const pod of pods) {
          const labels = pod.metadata?.labels || {};
          if (Object.entries(selector).every(([k, v]) => labels[k] === v)) {
            addEdge(idFor('Pod', pod.metadata.name), svcId, 'service');
          }
        }
      }
    }
    for (const ing of get('Ingress')) {
      const ingId = addNode('Ingress', ing.metadata.name);
      const spec = ing.spec || {};
      const svcNames = new Set();
      if (spec.defaultBackend?.service?.name) svcNames.add(spec.defaultBackend.service.name);
      (spec.rules || []).forEach(r => (r.http?.paths || []).forEach(p => {
        if (p.backend?.service?.name) svcNames.add(p.backend.service.name);
      }));
      svcNames.forEach(n => addEdge(idFor('Service', n), ingId, 'network'));
    }
    for (const np of get('NetworkPolicy')) {
      const npId = addNode('NetworkPolicy', np.metadata.name);
      const sel = np.spec?.podSelector?.matchLabels || {};
      for (const pod of pods) {
        const labels = pod.metadata?.labels || {};
        if (Object.entries(sel).every(([k, v]) => labels[k] === v)) {
          addEdge(idFor('Pod', pod.metadata.name), npId, 'network');
        }
      }
    }

    // ---- storage: pvc -> pv / storageclass, pod -> pvc ----
    const pvcNames = new Set();
    const scNames = new Set();
    const pvNames = new Set();
    for (const pvc of get('PersistentVolumeClaim')) {
      const pvcId = addNode('PersistentVolumeClaim', pvc.metadata.name);
      pvcNames.add(pvc.metadata.name);
      if (pvc.spec?.volumeName) { pvNames.add(pvc.spec.volumeName); }
      if (pvc.spec?.storageClassName) {
        scNames.add(pvc.spec.storageClassName);
        addEdge(pvcId, addNode('StorageClass', pvc.spec.storageClassName), 'storage');
      }
    }

    // ---- config + rbac + storage refs discovered from pod specs ----
    const cmSet = new Set(), secretSet = new Set(), saSet = new Set();
    const podRefs = (pod) => {
      const spec = pod.spec || {};
      const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
      (spec.volumes || []).forEach(v => {
        if (v.configMap?.name) cmSet.add(v.configMap.name);
        if (v.secret?.secretName) secretSet.add(v.secret.secretName);
        if (v.persistentVolumeClaim?.claimName) pvcNames.add(v.persistentVolumeClaim.claimName);
        (v.projected?.sources || []).forEach(s => {
          if (s.configMap?.name) cmSet.add(s.configMap.name);
          if (s.secret?.name) secretSet.add(s.secret.name);
        });
      });
      containers.forEach(c => {
        (c.envFrom || []).forEach(ef => {
          if (ef.configMapRef?.name) cmSet.add(ef.configMapRef.name);
          if (ef.secretRef?.name) secretSet.add(ef.secretRef.name);
        });
        (c.env || []).forEach(e => {
          if (e.valueFrom?.configMapKeyRef?.name) cmSet.add(e.valueFrom.configMapKeyRef.name);
          if (e.valueFrom?.secretKeyRef?.name) secretSet.add(e.valueFrom.secretKeyRef.name);
        });
      });
      (spec.imagePullSecrets || []).forEach(s => { if (s.name) secretSet.add(s.name); });
      return spec.serviceAccountName || spec.serviceAccount || null;
    };

    for (const pod of pods) {
      const podId = idFor('Pod', pod.metadata.name);
      const sa = podRefs(pod);
      // edges: pod -> each newly-referenced cm/secret it introduced
      for (const name of pod.spec?.volumes?.map(v => v.persistentVolumeClaim?.claimName).filter(Boolean) || []) {
        addEdge(podId, idFor('PersistentVolumeClaim', name), 'storage');
      }
      // re-derive this pod's own references for precise edges
      const spec = pod.spec || {};
      const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
      const myCm = new Set(), mySec = new Set();
      (spec.volumes || []).forEach(v => {
        if (v.configMap?.name) myCm.add(v.configMap.name);
        if (v.secret?.secretName) mySec.add(v.secret.secretName);
        (v.projected?.sources || []).forEach(s => {
          if (s.configMap?.name) myCm.add(s.configMap.name);
          if (s.secret?.name) mySec.add(s.secret.name);
        });
      });
      containers.forEach(c => {
        (c.envFrom || []).forEach(ef => {
          if (ef.configMapRef?.name) myCm.add(ef.configMapRef.name);
          if (ef.secretRef?.name) mySec.add(ef.secretRef.name);
        });
        (c.env || []).forEach(e => {
          if (e.valueFrom?.configMapKeyRef?.name) myCm.add(e.valueFrom.configMapKeyRef.name);
          if (e.valueFrom?.secretKeyRef?.name) mySec.add(e.valueFrom.secretKeyRef.name);
        });
      });
      (spec.imagePullSecrets || []).forEach(s => { if (s.name) mySec.add(s.name); });
      myCm.forEach(n => addEdge(podId, addNode('ConfigMap', n), 'config'));
      mySec.forEach(n => addEdge(podId, addNode('Secret', n), 'config'));
      if (sa) { saSet.add(sa); addEdge(podId, addNode('ServiceAccount', sa), 'rbac'); }
    }

    // rbac chain: serviceaccount -> rolebinding -> role
    for (const rb of get('RoleBinding')) {
      const subjects = rb.subjects || [];
      const linkedSAs = subjects.filter(s => s.kind === 'ServiceAccount' && saSet.has(s.name));
      if (!linkedSAs.length) continue;
      const rbId = addNode('RoleBinding', rb.metadata.name);
      linkedSAs.forEach(s => addEdge(idFor('ServiceAccount', s.name), rbId, 'rbac'));
      const ref = rb.roleRef;
      if (ref?.name) addEdge(rbId, addNode(ref.kind || 'Role', ref.name), 'rbac');
    }

    // ---- cluster-scoped storage (PVs + StorageClasses) bound to this namespace ----
    if (pvNames.size || scNames.size) {
      try {
        const opts = requestOptions(15000);
        const [pvs, scs] = await Promise.all([
          kubeConfig.makeApiClient(k8s.CoreV1Api).listPersistentVolume({}, opts),
          kubeConfig.makeApiClient(k8s.StorageV1Api).listStorageClass({}, opts),
        ]);
        const cluster = [...tagKind(pvs.items, 'PersistentVolume'), ...tagKind(scs.items, 'StorageClass')];
        for (const it of cluster) {
          if (it.kind === 'PersistentVolume' && pvNames.has(it.metadata.name)) {
            rawByKind.set(idFor('PersistentVolume', it.metadata.name), it);
            const pvId = addNode('PersistentVolume', it.metadata.name);
            // pvc -> pv
            const claim = it.spec?.claimRef;
            if (claim && claim.namespace === namespace) {
              addEdge(idFor('PersistentVolumeClaim', claim.name), pvId, 'storage');
            }
            if (it.spec?.storageClassName) {
              addEdge(pvId, addNode('StorageClass', it.spec.storageClassName), 'storage');
            }
          }
          if (it.kind === 'StorageClass' && scNames.has(it.metadata.name)) {
            rawByKind.set(idFor('StorageClass', it.metadata.name), it);
            // ensure node exists (status Active) if referenced
            addNode('StorageClass', it.metadata.name);
          }
        }
      } catch { /* cluster-scoped fetch optional; skip on RBAC failure */ }
    }

    // keep only edges whose endpoints exist as nodes; dedupe
    const seen = new Set();
    const validEdges = edges.filter(e => {
      if (!nodeIndex.has(e.source) || !nodeIndex.has(e.target)) return false;
      const key = `${e.source}|${e.target}|${e.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const result = { nodes, edges: validEdges };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    fail(res, error, { nodes: [], edges: [] });
  }
});

// Derive a simple status for a single container from its containerStatus.
// running -> 'running', waiting(bad reason)/terminated(non-zero) -> 'failed',
// waiting(other) -> 'pending', missing status -> 'unknown'
function containerState(cs) {
  if (!cs || !cs.state) return 'unknown';
  if (cs.state.running) return 'running';
  if (cs.state.terminated) {
    return cs.state.terminated.exitCode === 0 ? 'running' : 'failed';
  }
  if (cs.state.waiting) {
    const reason = cs.state.waiting.reason || '';
    const bad = /CrashLoopBackOff|Error|ImagePull|InvalidImageName|CreateContainer|RunContainer|CreateContainerConfigError/i.test(reason);
    return bad ? 'failed' : 'pending';
  }
  return 'unknown';
}

function formatResource(item, kind) {
  const resolvedKind = kind || item.kind;
  const out = {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    kind: resolvedKind,
    createdAt: item.metadata.creationTimestamp,
    status: getResourceStatus(item, resolvedKind)
  };
  if (resolvedKind === 'Pod') {
    out.node = item.spec?.nodeName || null;
    out.containerNames = (item.spec?.containers || []).map(c => c.name);
    const cs = item.status?.containerStatuses || [];
    const byName = {};
    cs.forEach(c => { byName[c.name] = c; });
    out.containerStates = (item.spec?.containers || []).map(c => ({
      name: c.name,
      status: containerState(byName[c.name])
    }));
    out.containers = out.containerNames.length || cs.length;
    out.restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0);
  }
  if (resolvedKind === 'ConfigMap') {
    out.dataKeys = Object.keys(item.data || {}).length + Object.keys(item.binaryData || {}).length;
  }
  if (resolvedKind === 'Secret') {
    out.secretType = item.type || 'Opaque';
    out.dataKeys = Object.keys(item.data || {}).length;
  }
  if (resolvedKind === 'ServiceAccount') {
    out.saSecrets = (item.secrets || []).length;
  }
  if (resolvedKind === 'NetworkPolicy') {
    out.policyTypes = (item.spec?.policyTypes || []).join(', ') || '-';
  }
  if (resolvedKind === 'Ingress') {
    out.ingressClass = item.spec?.ingressClassName || '-';
    out.hosts = (item.spec?.rules || []).map(r => r.host).filter(Boolean).join(', ') || '-';
  }
  if (resolvedKind === 'PersistentVolumeClaim') {
    out.capacity = item.status?.capacity?.storage || item.spec?.resources?.requests?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.volume = item.spec?.volumeName || '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'PersistentVolume') {
    out.capacity = item.spec?.capacity?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.reclaimPolicy = item.spec?.persistentVolumeReclaimPolicy || '-';
    out.claim = item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'StorageClass') {
    out.provisioner = item.provisioner || '-';
    out.reclaimPolicy = item.reclaimPolicy || 'Delete';
    out.bindingMode = item.volumeBindingMode || 'Immediate';
  }
  return out;
}

// `kind` is passed explicitly because list items from the client library
// don't carry a per-item `kind` field.
function getResourceStatus(item, kind) {
  const status = item.status || {};
  if (kind === 'Pod') {
    return status.phase || 'Unknown';
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const ready = status.readyReplicas != null ? status.readyReplicas
      : (status.numberReady != null ? status.numberReady : 0);
    const desired = status.replicas != null ? status.replicas
      : (status.desiredNumberScheduled != null ? status.desiredNumberScheduled : 0);
    return `${ready}/${desired}`;
  }
  if (kind === 'Service') {
    return item.spec?.type || 'Unknown';
  }
  if (kind === 'PersistentVolume' || kind === 'PersistentVolumeClaim') {
    return status.phase || 'Unknown';
  }
  if (kind === 'StorageClass') {
    return '';
  }
  return 'Unknown';
}

// ------------------------------------------------------------------
// MCP endpoint (Streamable HTTP). Any MCP-compatible AI agent can connect to
// /mcp to drive the cluster this app is attached to. Stateful: an initialize
// request mints a session id; later requests reuse the same server via the
// Mcp-Session-Id header.
// ------------------------------------------------------------------
// Sessions: Map of id → { transport, lastSeen }; idle sessions are evicted
// (transport closed) after 30 min. Session ids must look like ids.
const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
const mcpTransports = new Map();
const mcpSessionHeader = (req) => {
  const sid = req.headers['mcp-session-id'];
  if (sid === undefined) return { sid: undefined };
  if (!isMcpSessionId(sid)) return { invalid: true };
  return { sid };
};
const touchMcpSession = (sid) => { const s = mcpTransports.get(sid); if (s) s.lastSeen = Date.now(); return s?.transport; };
const evictMcpSession = (sid) => {
  const s = mcpTransports.get(sid);
  if (!s) return;
  mcpTransports.delete(sid);
  Promise.resolve(s.transport.close?.()).catch(() => {});
};
const mcpSweeper = setInterval(() => {
  const cutoff = Date.now() - MCP_SESSION_IDLE_MS;
  for (const [sid, s] of mcpTransports) if (s.lastSeen < cutoff) { log.info('evicting idle MCP session'); evictMcpSession(sid); }
}, 60_000);
mcpSweeper.unref();

app.post('/mcp', async (req, res) => {
  try {
    const { sid, invalid } = mcpSessionHeader(req);
    if (invalid) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: malformed Mcp-Session-Id' }, id: null });
    let transport = sid ? touchMcpSession(sid) : undefined;
    if (!transport && !sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { mcpTransports.set(id, { transport, lastSeen: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) mcpTransports.delete(transport.sessionId); };
      const mcp = createMcpServer({
        version: getAppVersion(),
        allowWrite: mcpAllowWrite,
        apiBase: `http://127.0.0.1:${PORT}`,
        token: getAuthToken(),
      });
      await mcp.connect(transport);
    } else if (!transport) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id (send an initialize request first)' }, id: null });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    log.error('MCP request failed', { err: error });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// GET (server→client notification stream) and DELETE (end session) reuse the session.
const mcpSession = async (req, res) => {
  try {
    const { sid, invalid } = mcpSessionHeader(req);
    const transport = sid && !invalid ? touchMcpSession(sid) : undefined;
    if (!transport) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing Mcp-Session-Id' }, id: null });
    await transport.handleRequest(req, res);
    if (req.method === 'DELETE') evictMcpSession(sid);
  } catch (error) {
    log.error('MCP session request failed', { err: error });
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
};
app.get('/mcp', mcpSession);
app.delete('/mcp', mcpSession);

// SPA fallback: serve index.html for non-API routes (production build)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  const indexFile = path.join(CLIENT_DIST, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

// ============================================================
// AI assistant (read-only, agentic, streams over SSE)
// ============================================================
registerAssistant(app, {
  k8s,
  getKubeConfig: () => kubeConfig,
  getCurrentContext: () => currentContext,
  helmReleases: async () => latestHelmReleases(await listHelmReleaseSecrets()),
});

// Unknown /api or /mcp route → JSON 404 (after every router, incl. the assistant).
app.use(['/api', '/mcp'], apiNotFound);
// Final JSON error handler: 413 / 400 for body parsing, { error, code } shape,
// never a stack trace.
app.use(errorMiddleware(log));

// ============================================================
// Interactive shell over WebSocket (real TTY via k8s exec)
// ============================================================
const server = http.createServer(app);
const MAX_TERMINALS = 20;
const WS_HEARTBEAT_MS = 30_000;
const terminals = new Set(); // live PTYs (for the cap and for shutdown)

// Environment handed to the pod-exec PTY: an allowlist, not the whole server
// environment. Cloud exec-credential plugins need their SDK variables.
const PTY_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'KUBECONFIG', 'TERM', 'LANG', 'SHELL', 'SystemRoot', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const ptyEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (PTY_ENV_KEYS.includes(k) || /^(AWS_|AZURE_|GOOGLE_|KUBE|CLOUDSDK_)/.test(k)) env[k] = v;
  }
  return env;
};

// WebSocket handshakes are NOT subject to CORS and browsers cannot set headers
// on them, so the upgrade is authenticated here by hand: Host allowlist,
// Origin rule, bearer token (?token=…), then parameter validation — each
// failure answered with a JSON HTTP response before any socket is upgraded.
const wss = new WebSocketServer({ noServer: true });
const rejectUpgrade = (socket, status, body) => {
  const text = JSON.stringify(body);
  const reason = http.STATUS_CODES[status] || 'Error';
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  } catch { /* ignore */ }
  socket.destroy();
};
server.on('upgrade', async (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return rejectUpgrade(socket, 400, { error: 'Bad request', code: 'bad_request' }); }
  if (url.pathname !== '/ws/exec') return rejectUpgrade(socket, 404, { error: 'Not found', code: 'not_found' });
  if (!isAllowedHost(req.headers.host)) return rejectUpgrade(socket, 421, { error: 'Misdirected request' });
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) return rejectUpgrade(socket, 403, { error: 'Cross-origin request rejected', code: 'origin_rejected' });
  if (!verifyWsAuth(req)) return rejectUpgrade(socket, 401, { error: 'Unauthorized', code: 'auth_required' });
  const q = (k) => url.searchParams.get(k);
  const invalid = q('agent')
    ? firstInvalid([
      ['agent', q('agent'), (v) => AI_AGENTS.some((a) => a.id === v)],
      ['prompt', q('prompt'), (v) => v === null || v.length <= 16384],
    ])
    : firstInvalid([
      ['namespace', q('namespace'), isDnsLabel],
      ['pod', q('pod'), isDnsSubdomain],
      ['container', q('container'), (v) => v === null || v === '' || isContainer(v)],
    ]);
  if (invalid) return rejectUpgrade(socket, 400, { error: `Invalid ${invalid}`, code: 'invalid_param', field: invalid });
  // The pod terminal is a real PTY around `kubectl exec -it`: without kubectl
  // (and outside demo mode) answer with the actionable JSON error up front.
  if (!q('agent') && !demoActive()) {
    let kubectl;
    try { kubectl = await hasKubectl(); } catch { kubectl = { available: false }; }
    if (!kubectl.available) return rejectUpgrade(socket, 501, { error: KUBECTL_REQUIRED_MESSAGE, code: 'kubectl_required' });
  }
  if (terminals.size >= MAX_TERMINALS) return rejectUpgrade(socket, 429, { error: `At most ${MAX_TERMINALS} terminals may be open at once`, code: 'too_many_terminals' });
  if (shuttingDown) return rejectUpgrade(socket, 503, { error: 'Server is shutting down', code: 'shutting_down' });
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Heartbeat: ping every 30 s, terminate sockets that missed a pong.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, WS_HEARTBEAT_MS);
wsHeartbeat.unref();

wss.on('connection', async (browserWs, req) => {
  browserWs.isAlive = true;
  browserWs.on('pong', () => { browserWs.isAlive = true; });
  const url = new URL(req.url, 'http://localhost');

  // Demo mode (KUBEPILOT_DEMO=1 only): a scripted pseudo-terminal instead of a real pod exec.
  if (demoActive()) {
    demo.shellSession(browserWs, {
      agent: url.searchParams.get('agent'),
      namespace: url.searchParams.get('namespace'),
      pod: url.searchParams.get('pod'),
      container: url.searchParams.get('container'),
    });
    return;
  }

  if (!kubeConfig) {
    browserWs.close(1011, 'No kubeconfig loaded');
    return;
  }

  const send = (data) => { if (browserWs.readyState === 1) browserWs.send(data); };
  if (!pty) {
    send('\r\n\x1b[31mTerminal is unavailable on this server (node-pty failed to load).\x1b[0m\r\n');
    browserWs.close();
    return;
  }

  const agentId = url.searchParams.get('agent');
  let term, cleanup = () => {};

  if (agentId) {
    // ---- AI agent terminal: a login shell with the app's current cluster
    // context pinned via a temp kubeconfig, then launch the chosen agent CLI.
    // Only a known agent id is accepted (validated at upgrade). ----
    const info = AI_AGENTS.find((a) => a.id === agentId);
    if (!info) { send('\r\n\x1b[31mUnknown AI agent.\x1b[0m\r\n'); browserWs.close(); return; }
    const command = info.command;

    let kubeconfigPath = getKubeConfigPath();
    try {
      const tmp = path.join(os.tmpdir(), `km-agent-${randomUUID()}.yaml`);
      fs.writeFileSync(tmp, kubeConfig.exportConfig(), { mode: 0o600 });
      scheduleTempUnlink(tmp);
      kubeconfigPath = tmp;
      cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
    } catch { /* fall back to the default kubeconfig path */ }

    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/bash');
    const shellArgs = isWin ? [] : ['-l'];
    try {
      term = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: process.env.HOME || os.homedir(),
        env: { ...process.env, KUBECONFIG: kubeconfigPath, KUBE_CONTEXT: currentContext || '' },
      });
    } catch (err) {
      cleanup();
      send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
      browserWs.close();
      return;
    }
    // Once the shell is ready, launch the agent (with an optional seed prompt).
    const prompt = url.searchParams.get('prompt');
    const quote = isWin
      ? (s) => `"${String(s).replace(/[\r\n"]/g, ' ')}"` // cmd.exe: no reliable escaping — strip quotes/newlines
      : shq;
    const launch = prompt ? `${command} ${quote(prompt)}\r` : `${command}\r`;
    setTimeout(() => { try { term.write(launch); } catch { /* ignore */ } }, 700);
  } else {
    // ---- pod exec: bridge to `kubectl exec -it` in a real PTY (robust against
    // exec-credential auth plugins that break client-node's WebSocket exec).
    // namespace/pod/container were validated at upgrade time. ----
    const namespace = url.searchParams.get('namespace');
    const pod = url.searchParams.get('pod');
    const container = url.searchParams.get('container') || undefined;
    const args = [
      ...(currentContext ? [`--context=${currentContext}`] : []),
      'exec', '-it', `--namespace=${namespace}`, ...(container ? [`--container=${container}`] : []),
      pod, '--', 'sh', '-c', 'exec $(command -v bash || command -v sh || echo /bin/sh)',
    ];
    const kubectlBin = resolveBinSync('kubectl');
    try {
      term = pty.spawn(kubectlBin, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.HOME || os.homedir(), env: ptyEnv() });
    } catch (err) {
      const missing = kubectlBin === 'kubectl' || isSpawnMissing(err) || /ENOENT/.test(String(err?.message || ''));
      const text = missing ? KUBECTL_REQUIRED_MESSAGE : `Failed to start shell: ${err.message}`;
      send(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
      browserWs.close();
      return;
    }
  }

  terminals.add(term);
  term.onData((data) => send(data));
  term.onExit(({ exitCode }) => {
    terminals.delete(term);
    if (browserWs.readyState === 1 && exitCode) send(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    try { browserWs.close(); } catch (e) { /* ignore */ }
  });

  browserWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.type === 'data') {
      if (typeof msg.data !== 'string') return;
      try { term.write(msg.data); } catch (e) { /* ignore */ }
    } else if (msg.type === 'resize' && isIntInRange(msg.cols, 1, 1000) && isIntInRange(msg.rows, 1, 1000)) {
      try { term.resize(Number(msg.cols), Number(msg.rows)); } catch (e) { /* ignore */ }
    }
  });

  browserWs.on('close', () => {
    terminals.delete(term);
    try { term.kill(); } catch (e) { /* ignore */ }
    cleanup();
  });
});

let handledFatal = false;
const handleServerError = (err) => {
  if (handledFatal) return;
  handledFatal = true;
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use — another instance of the app (or a process using this port) is already running. Stop it and try again.`, { port: PORT, code: err.code });
  } else {
    log.error('server error', { err });
  }
  log.flush().then(() => process.exit(1));
};
server.on('error', handleServerError);
wss.on('error', handleServerError);

// ------------------------------------------------------------------
// Graceful shutdown + last-resort process handlers
// ------------------------------------------------------------------
let shuttingDown = false;
const SHUTDOWN_GRACE_MS = 5000;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const exit = (code) => log.flush().then(() => process.exit(code));
  const finalTimer = setTimeout(() => { try { server.closeAllConnections?.(); } catch { /* ignore */ } exit(0); }, SHUTDOWN_GRACE_MS);
  finalTimer.unref();
  try { server.close(() => { clearTimeout(finalTimer); exit(0); }); } catch { /* ignore */ }
  try { server.closeIdleConnections?.(); } catch { /* ignore */ }
  clearInterval(wsHeartbeat);
  clearInterval(mcpSweeper);
  cache.stop();
  for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } } // 'close' handlers kill their PTYs
  for (const term of terminals) { try { term.kill(); } catch { /* ignore */ } }
  terminals.clear();
  killAllForwards();
  for (const sid of [...mcpTransports.keys()]) evictMcpSession(sid);
  try { azLogin?.proc?.kill(); } catch { /* ignore */ }
  try { azure.cancelLogin(); } catch { /* ignore */ }
  try { trivyScan.cancelAll?.(); } catch { /* ignore */ }
  for (const child of trackedChildren) { try { child.kill(); } catch { /* ignore */ } }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  log.flush().then(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

// Bind to loopback by default so the API/exec surface is not reachable from
// other hosts on the LAN. Set HOST=0.0.0.0 to expose it (the Docker image does
// this so its published port works); prefer `-p 127.0.0.1:8080:3001` there.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const base = `http://${shown}:${PORT}`;
  // The login URL (token in the fragment): the client stores it from the hash.
  log.raw(`KubePilot listening on ${base}  —  open ${base}/#token=${getAuthToken()}`);
  log.info('listening', { host: HOST, port: PORT, bound: HOST === '0.0.0.0' ? '0.0.0.0' : HOST });
});
