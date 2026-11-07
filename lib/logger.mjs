// Tiny structured JSON logger + request logger. One line per record:
//   {"level":"info","time":"…","msg":"…", ...fields}
// Honors LOG_LEVEL (debug|info|warn|error; default info). Never log headers,
// request bodies or tokens through this — callers pass only scalar fields.
import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelName = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[levelName] ?? LEVELS.info;

function safeFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = { message: v.message, code: v.code, ...(threshold <= LEVELS.debug && v.stack ? { stack: v.stack } : {}) };
    } else if (v === undefined) {
      continue;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, msg, fields) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const rec = { level, time: new Date().toISOString(), msg: String(msg), ...safeFields(fields) };
  let line;
  try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ level, time: rec.time, msg: rec.msg }); }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export const logger = {
  level: levelName,
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  // A plain (non-JSON) line for human-facing boot output such as the login URL.
  raw: (line) => process.stdout.write(String(line) + '\n'),
  // Resolve once stdout/stderr have drained — used before process.exit(1).
  flush: () => new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending === 0) resolve(); };
    for (const s of [process.stdout, process.stderr]) {
      if (s.writableNeedDrain) s.once('drain', done); else done();
    }
    setTimeout(resolve, 500).unref();
  }),
};

// A caller's own X-Request-Id is kept when it looks like one; anything else
// gets a fresh id.
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** The request's id (set by requestLogger), for log lines about it. */
export const requestIdOf = (req) => (typeof req?.id === 'string' ? req.id : undefined);

// Express middleware: method, path (never the query string), status, duration,
// and a request id. The id is also the X-Request-Id response header, so a
// failure the UI shows can be matched to the backend's log lines about it.
export function requestLogger(log = logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const incoming = typeof req.get === 'function' ? req.get('x-request-id') : req.headers?.['x-request-id'];
    req.id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const fields = {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      };
      if (res.statusCode >= 500) log.warn('request', fields);
      else log.info('request', fields);
    });
    next();
  };
}
