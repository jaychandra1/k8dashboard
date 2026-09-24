// HTTP error helpers: a typed error, a mapper for Kubernetes / kubectl /
// network failures, and the final JSON error middleware. Responses always have
// the shape { error, code, ...extra } and never carry stack traces.

export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Mirrors lib/kubectl.mjs (kept here too so this module stays dependency-free).
export const KUBECTL_REQUIRED_MESSAGE =
  'kubectl is required for the pod terminal and port-forward. Install it from https://kubernetes.io/docs/tasks/tools/ and add it to your PATH.';

export const badRequest = (message, code = 'bad_request', extra) => new HttpError(400, message, code, extra);
export const invalidParam = (field, message) =>
  new HttpError(400, message || `Invalid ${field}`, 'invalid_param', { field });
export const forbidden = (message, code = 'forbidden') => new HttpError(403, message, code);
export const notFound = (message, code = 'not_found') => new HttpError(404, message, code);
export const conflict = (message, code = 'conflict') => new HttpError(409, message, code);

const numericStatus = (err) => {
  const cands = [err?.code, err?.statusCode, err?.status, err?.response?.statusCode, err?.body?.code];
  for (const c of cands) if (typeof c === 'number' && c >= 100 && c <= 599) return c;
  return undefined;
};

const messageOf = (err, fallback) => {
  if (!err) return fallback;
  const m = err.body?.message || err.body?.reason || err.stderr || err.message;
  return (typeof m === 'string' && m.trim()) ? m.trim() : (fallback || String(err));
};

// Map an arbitrary upstream failure (client-node ApiException, kubectl error,
// fetch/network error) to { status, error, code }. K8s 404 → 404, 401/403 →
// 403 'forbidden', everything else → 502 'upstream_error'.
export function mapUpstreamError(err, fallback = 'Upstream request failed') {
  if (err instanceof HttpError) return { status: err.status, error: err.message, code: err.code, ...(err.extra || {}) };
  const status = numericStatus(err);
  const message = messageOf(err, fallback);
  // A stray `spawn kubectl ENOENT` (or our own marker) → the friendly, actionable message.
  if (err?.code === 'kubectl_required' || (err?.code === 'ENOENT' && /\bspawn\b.*kubectl/i.test(message))) {
    return { status: 501, error: KUBECTL_REQUIRED_MESSAGE, code: 'kubectl_required' };
  }
  if (status === 404) return { status: 404, error: message, code: 'not_found' };
  if (status === 401 || status === 403) return { status: 403, error: message, code: 'forbidden' };
  // kubectl reports API errors as text on stderr; classify the common ones.
  if (err?.stderr && /\(NotFound\)|\bnot found\b/i.test(message)) return { status: 404, error: message, code: 'not_found' };
  if (err?.stderr && /\(Forbidden\)|\(Unauthorized\)/.test(message)) return { status: 403, error: message, code: 'forbidden' };
  return { status: 502, error: message, code: 'upstream_error' };
}

// Send a mapped error. `extra` (e.g. { items: [] }) is merged so clients that
// read a list key on error keep working.
export function sendError(res, err, extra = undefined, fallback = undefined) {
  if (res.headersSent) return;
  const { status, ...body } = mapUpstreamError(err, fallback);
  res.status(status).json({ ...(extra || {}), ...body });
}

// JSON 404 for unknown API routes.
export function apiNotFound(req, res) {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, code: 'not_found' });
}

// Final error middleware — body-parser errors, our HttpError, anything else.
export function errorMiddleware(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large', code: 'payload_too_large' });
    }
    if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in (err || {}))) {
      return res.status(400).json({ error: 'Malformed JSON body', code: 'invalid_json' });
    }
    if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      return res.status(415).json({ error: 'Unsupported request encoding', code: 'unsupported_media_type' });
    }
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message || 'Bad request', code: 'bad_request' });
    }
    log?.error('unhandled request error', { method: req.method, path: req.path, err });
    res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
  };
}
