// Jupyter-style bearer-token auth + Host / Origin allowlists.
//
// Token source order: KUBEPILOT_TOKEN env (legacy names via lib/paths.mjs) →
// ~/.config/kubepilot/token → legacy config dirs (see lib/paths.mjs) → generated
// (32 random bytes, base64url) and persisted with mode 0600. The token is
// required on every /api and /mcp request (Authorization: Bearer) and on the
// /ws/exec upgrade (?token=). Only GET /healthz and GET /api/version are open.
import crypto from 'crypto';
import fs from 'fs';
import { CONFIG_DIR, configFile, envToken, envVar, findConfigFile } from './paths.mjs';

const TOKEN_FILE = configFile('token');
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

let cachedToken = null;
let tokenBuf = null;

export function getAuthToken() {
  if (cachedToken) return cachedToken;
  let token = envToken();
  if (!token) {
    const existing = findConfigFile('token');
    try { token = fs.readFileSync(existing, 'utf8').trim(); } catch { token = ''; }
    if (!TOKEN_SHAPE.test(token)) token = '';
  }
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
      fs.renameSync(tmp, TOKEN_FILE);
    } catch { /* fall back to an in-memory token for this run */ }
  }
  cachedToken = token;
  tokenBuf = Buffer.from(token, 'utf8');
  return token;
}

export function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  getAuthToken();
  const c = Buffer.from(candidate, 'utf8');
  if (c.length !== tokenBuf.length) return false;
  return crypto.timingSafeEqual(c, tokenBuf);
}

// ------------------------------------------------------------------
// MCP token: a second credential for AI agents (Preferences → MCP). Requests
// made with it are MCP requests whatever headers they send, so the write gate
// and the UI-only routes (terminals, settings, kubeconfig, cloud logins,
// updates) apply to the agent by construction. It is persisted in
// ~/.config/kubepilot/mcp-token (0600) so agent configs survive restarts —
// unlike the desktop app's per-launch UI token — and can be regenerated.
// KUBEPILOT_MCP_TOKEN pins it (e.g. for a server).
// ------------------------------------------------------------------
const MCP_TOKEN_FILE = configFile('mcp-token');
let mcpToken = null;
let mcpBuf = null;

function persistToken(file, token) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getMcpToken() {
  if (mcpToken) return mcpToken;
  let token = envVar('MCP_TOKEN').trim();
  if (!token) {
    try { token = fs.readFileSync(MCP_TOKEN_FILE, 'utf8').trim(); } catch { token = ''; }
    if (!TOKEN_SHAPE.test(token)) token = '';
  }
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    try { persistToken(MCP_TOKEN_FILE, token); } catch { /* in-memory for this run */ }
  }
  // Never the same value as the UI token (e.g. both pinned to one secret).
  if (token === getAuthToken()) token = crypto.randomBytes(32).toString('base64url');
  mcpToken = token;
  mcpBuf = Buffer.from(token, 'utf8');
  return token;
}

/** Replace the MCP token (Preferences → MCP → Regenerate). Returns the new one. */
export function rotateMcpToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  persistToken(MCP_TOKEN_FILE, token);
  mcpToken = token;
  mcpBuf = Buffer.from(token, 'utf8');
  return token;
}

const sameBytes = (c, buf) => c.length === buf.length && crypto.timingSafeEqual(c, buf);

/** Who presents `candidate`: 'ui' (the API token), 'mcp' (the MCP token) or null. */
export function tokenPrincipal(candidate) {
  if (typeof candidate !== 'string' || !candidate) return null;
  getAuthToken();
  getMcpToken();
  const c = Buffer.from(candidate, 'utf8');
  const ui = sameBytes(c, tokenBuf);
  const mcp = sameBytes(c, mcpBuf);
  return ui ? 'ui' : mcp ? 'mcp' : null;
}

const bearerOf = (req) => {
  const h = req.headers?.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
};

// Case-insensitive prefix test — the routing normalizer separately 404s any
// odd-cased /API path, so this is belt-and-braces.
export const isProtectedPath = (p) => {
  const l = String(p || '').toLowerCase();
  return l.startsWith('/api') || l.startsWith('/mcp');
};

const isPublicRequest = (req) =>
  req.method === 'GET' && (req.path === '/healthz' || req.path === '/api/version');

// req.kubepilotPrincipal records which token was used ('ui' | 'mcp'); see
// isMcpSource() in lib/paths.mjs.
export function authMiddleware(req, res, next) {
  if (!isProtectedPath(req.path)) return next();
  if (isPublicRequest(req)) return next();
  const principal = tokenPrincipal(bearerOf(req));
  if (principal) {
    req.kubepilotPrincipal = principal;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', code: 'auth_required' });
}

// WebSocket upgrade: ?token=… (browsers cannot set headers on a WS handshake);
// an Authorization header is accepted too for non-browser clients. Terminals
// are UI-only: the MCP token never opens one.
export function verifyWsAuth(req) {
  let t = bearerOf(req);
  if (!t) {
    try { t = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch { t = null; }
  }
  return tokenMatches(t);
}

// ------------------------------------------------------------------
// Host allowlist (DNS-rebinding defence). Applied to ALL requests.
// ------------------------------------------------------------------
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const lower = (s) => String(s || '').toLowerCase();

// Parse "host[:port]" / "[v6]:port" → { hostname, port }.
export function parseHost(hostHeader) {
  const h = lower(hostHeader).trim();
  if (!h) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    return { hostname: h.slice(1, end), port: h.slice(end + 1).replace(/^:/, '') };
  }
  const i = h.lastIndexOf(':');
  if (i >= 0 && h.indexOf(':') === i) return { hostname: h.slice(0, i), port: h.slice(i + 1) };
  return { hostname: h, port: '' };
}

const originHost = (origin) => { try { return lower(new URL(origin).host); } catch { return ''; } };

const extraHosts = () => {
  const set = new Set(splitList(process.env.ALLOWED_HOSTS).map(lower));
  for (const o of splitList(process.env.ALLOWED_ORIGINS)) { const h = originHost(o); if (h) set.add(h); }
  return set;
};

export function isAllowedHost(hostHeader) {
  const parsed = parseHost(hostHeader);
  if (!parsed) return false;
  const full = lower(hostHeader).trim();
  if (LOOPBACK.has(parsed.hostname)) return true;
  const extra = extraHosts();
  if (extra.has(full) || extra.has(parsed.hostname)) return true;
  for (const e of extra) {
    const p = parseHost(e);
    if (p && !p.port && p.hostname === parsed.hostname) return true;
  }
  return false;
}

export function hostGuard(req, res, next) {
  if (isAllowedHost(req.headers.host)) return next();
  res.status(421).json({ error: 'Misdirected request' });
}

// ------------------------------------------------------------------
// Origin allowlist for /api, /mcp and the WS upgrade.
//
// A request WITHOUT an Origin header is allowed ONLY because the bearer token
// is also required on every one of these paths: an ambient-credential CSRF
// from a browser page cannot present the token, and non-browser clients (curl,
// the MCP stdio bridge, the server's own self-calls) never send Origin.
// ------------------------------------------------------------------
const DEV_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

export function isAllowedOrigin(origin, hostHeader) {
  if (origin === undefined || origin === null || origin === '') return true; // see comment above
  if (typeof origin !== 'string' || origin === 'null') return false;
  const oh = originHost(origin);
  if (!oh) return false;
  const oLower = lower(origin);
  const extraOrigins = new Set(splitList(process.env.ALLOWED_ORIGINS).map(lower));
  if (extraOrigins.has(oLower)) return true;
  if (process.env.NODE_ENV !== 'production' && DEV_ORIGINS.has(oLower)) return true;
  // Same-origin: the Origin's host must equal the (already allowlisted) Host.
  if (!isAllowedHost(oh)) return false;
  return oh === lower(hostHeader).trim();
}

export function originGuard(req, res, next) {
  if (isAllowedOrigin(req.headers.origin, req.headers.host)) return next();
  res.status(403).json({ error: 'Cross-origin request rejected', code: 'origin_rejected' });
}

// Strict lowercase check for the reserved prefixes: /API/… and /Mcp/… are
// rejected outright so a case variant can never slip past a prefix guard.
export function pathCaseGuard(req, res, next) {
  const seg = String(req.path || '').split('/')[1] || '';
  const l = seg.toLowerCase();
  if ((l === 'api' || l === 'mcp') && seg !== l) {
    return res.status(404).json({ error: 'Not found', code: 'not_found' });
  }
  next();
}
