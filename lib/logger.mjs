// Tiny structured JSON logger + request logger. One line per record:
//   {"level":"info","time":"…","msg":"…", ...fields}
// Honors LOG_LEVEL (debug|info|warn|error; default info). Never log headers,
// request bodies or tokens through this — callers pass only scalar fields.
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

// Express middleware: method, path (never the query string), status, duration.
export function requestLogger(log = logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      log.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });
    next();
  };
}
