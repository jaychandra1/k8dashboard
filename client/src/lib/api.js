// The ONLY HTTP/WS entry point for the client. Adds the bearer token and the
// X-Requested-With header to every /api call, normalises errors to ApiError,
// and notifies subscribers once on a 401 so the TokenPrompt can appear.
//
//   import { api, getJson, postJson, p, wsUrl, onUnauthorized } from '../lib/api';
//   const pods = await getJson(p('api', 'resources', ns), { signal });
//   const ws = new WebSocket(wsUrl('/ws/exec', { namespace, pod, container }));
import axios from 'axios';

const STORAGE_KEY = 'kubepilot.token';
// Keys written by earlier releases; read once, then migrated to STORAGE_KEY.
const LEGACY_STORAGE_KEYS = ['k8dashboard.token', 'k8sight.token'];
let memToken = null;

const storage = {
  get() {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map((k) => sessionStorage.getItem(k)).find(Boolean) || null;
    }
    catch { return null; }
  },
  set(v) {
    try {
      sessionStorage.setItem(STORAGE_KEY, v);
      for (const k of LEGACY_STORAGE_KEYS) sessionStorage.removeItem(k);
    } catch { /* fall back to memory */ }
  },
  del() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      for (const k of LEGACY_STORAGE_KEYS) sessionStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

export function getToken() {
  return memToken ?? storage.get() ?? null;
}

export function setToken(t) {
  const v = t == null ? '' : String(t).trim();
  if (!v) return clearToken();
  memToken = v;
  storage.set(v);
  unauthorizedFired = false;
}

export function clearToken() {
  memToken = null;
  storage.del();
}

/**
 * Pull `token=` out of the URL hash on boot ("#token=abc" or "#/pods?x=1&token=abc"),
 * persist it, and scrub it from the address bar. Returns true if a token was found.
 */
export function bootstrapTokenFromHash() {
  if (typeof location === 'undefined') return false;
  const hash = location.hash || '';
  const m = hash.match(/(^#|[?&#])token=([^&#]+)/);
  if (!m) return false;
  try { setToken(decodeURIComponent(m[2])); } catch { setToken(m[2]); }
  const cleaned = hash
    .replace(/([?&#])token=[^&#]*(&?)/, (all, sep, trail) => (sep === '?' || sep === '#' ? (trail ? sep : (sep === '#' ? '#' : '')) : ''))
    .replace(/[?&]$/, '')
    .replace(/^#$/, '');
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${cleaned && cleaned !== '#' ? cleaned : ''}`);
  } catch { /* ignore */ }
  return true;
}

// ---- errors ---------------------------------------------------------------

export class ApiError extends Error {
  /**
   * @param {{ status?: number, code?: string, message?: string, body?: any, url?: string, cause?: any }} init
   */
  constructor({ status = 0, code = 'error', message = 'Request failed', body = null, url = '', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.url = url;
    if (cause) this.cause = cause;
  }
  get isUnauthorized() { return this.status === 401; }
  get isAborted() { return this.code === 'aborted'; }
  get isNetwork() { return this.status === 0 && !this.isAborted; }
}

export const isAbortError = (e) => e?.code === 'aborted' || e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED';

function toApiError(err, url) {
  if (err instanceof ApiError) return err;
  if (isAbortError(err)) return new ApiError({ status: 0, code: 'aborted', message: 'Request aborted', url, cause: err });
  const res = err?.response;
  if (res) {
    const body = res.data;
    const message = (body && typeof body === 'object' && (body.error || body.message)) || (typeof body === 'string' && body) || err.message || `HTTP ${res.status}`;
    const code = (body && typeof body === 'object' && body.code) || (res.status === 401 ? 'auth_required' : res.status === 421 ? 'host_not_allowed' : `http_${res.status}`);
    return new ApiError({ status: res.status, code, message, body, url, cause: err });
  }
  return new ApiError({ status: 0, code: 'network', message: err?.message || 'Network error', url, cause: err });
}

// ---- 401 subscription -----------------------------------------------------

const unauthorizedSubs = new Set();
let unauthorizedFired = false;

/** Called once per "session" when a request returns 401. Returns unsubscribe. */
export function onUnauthorized(cb) {
  unauthorizedSubs.add(cb);
  return () => unauthorizedSubs.delete(cb);
}

function fireUnauthorized(err) {
  if (unauthorizedFired) return;
  unauthorizedFired = true;
  unauthorizedSubs.forEach((cb) => { try { cb(err); } catch { /* ignore */ } });
}

/** Reset the once-guard (TokenPrompt calls it after a successful reconnect). */
export function resetUnauthorized() { unauthorizedFired = false; }

// ---- axios instance -------------------------------------------------------

export const authHeaders = () => {
  const h = { 'X-Requested-With': 'kubepilot' };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
};

export const api = axios.create({ baseURL: '', timeout: 0 });

api.interceptors.request.use((config) => {
  config.headers = { ...(config.headers || {}), ...authHeaders() };
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const e = toApiError(err, err?.config?.url);
    if (e.status === 401) fireUnauthorized(e);
    return Promise.reject(e);
  },
);

// ---- helpers --------------------------------------------------------------

/** Join path segments with '/', encoding each one: p('api','pods',ns,name) → '/api/pods/ns/name'. */
export function p(...segments) {
  const parts = segments.flat().filter((s) => s !== undefined && s !== null && s !== '');
  const path = parts.map((s) => encodeURIComponent(String(s))).join('/');
  return `/${path}`;
}

/** Append a query string from an object (skips null/undefined/''). */
export function withQuery(url, params) {
  if (!params) return url;
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
}

export async function getJson(url, { signal, params, headers } = {}) {
  const { data } = await api.get(url, { signal, params, headers });
  return data;
}

export async function postJson(url, body, { signal, params, headers } = {}) {
  const { data } = await api.post(url, body ?? {}, { signal, params, headers });
  return data;
}

export async function putJson(url, body, { signal, params, headers } = {}) {
  const { data } = await api.put(url, body ?? {}, { signal, params, headers });
  return data;
}

export async function patchJson(url, body, { signal, params, headers } = {}) {
  const { data } = await api.patch(url, body ?? {}, { signal, params, headers });
  return data;
}

export async function del(url, { signal, params, headers, body } = {}) {
  const { data } = await api.delete(url, { signal, params, headers, data: body });
  return data;
}

/**
 * WebSocket URL for `path` built from location (ws:// or wss://), with the
 * token and any extra params in the query string.
 */
export function wsUrl(path, params = {}) {
  const loc = typeof location !== 'undefined' ? location : { protocol: 'http:', host: 'localhost' };
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${loc.host}${path.startsWith('/') ? path : `/${path}`}`;
  return withQuery(base, { ...params, token: getToken() || undefined });
}

/**
 * Raw fetch for streaming (SSE / chunked) responses that axios can't stream.
 * Adds the auth headers, throws ApiError on non-2xx, fires the 401 hook.
 */
export async function sseFetch(url, body, { signal, method = 'POST', headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw toApiError(err, url);
  }
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { try { parsed = await res.text(); } catch { /* ignore */ } }
    const e = new ApiError({
      status: res.status,
      code: (parsed && parsed.code) || (res.status === 401 ? 'auth_required' : `http_${res.status}`),
      message: (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status}`,
      body: parsed, url,
    });
    if (e.status === 401) fireUnauthorized(e);
    throw e;
  }
  return res;
}

/** Human-readable message for any error thrown by this module (or anything else). */
export function errorMessage(err, fallback = 'Something went wrong') {
  if (!err) return fallback;
  if (err instanceof ApiError) return err.message || fallback;
  return err.response?.data?.error || err.message || fallback;
}
