// Field diagnostics for the desktop app (audit OBS-01).
//
//   createLogFile(dir)   A small rotating log of the app's own output (the
//                        backend's log lines and the main process's events) in
//                        the OS log folder: k8board.log plus k8board.log.1….
//                        Credentials are scrubbed before anything is written.
//   diagnosticsReport()  The text Help → Export Diagnostics saves: app and OS
//                        versions, the shape of the settings (never their
//                        values) and the end of the log, with cluster
//                        endpoints, IP addresses, account and subscription
//                        IDs, emails and the home folder masked as well, so
//                        it can be attached to a bug report.
//
// No Electron imports: main.cjs passes in what it knows, and tests load this as is.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_NAME = 'k8board.log';
const MAX_BYTES = 2 * 1024 * 1024; // per file
const KEEP = 3; // rotated files kept besides the current one
const MAX_LINE = 4000;

// Credentials: never written to the log file.
const SECRET_RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2[redacted]'],
  [/([#?&](?:token|access_token|id_token|refresh_token|code|client_secret)=)[^\s&#"']+/gi, '$1[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})/g, '[redacted]'],
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&}]{3,})/gi,
    (m, key, sep, value) => (value.startsWith('[') ? m : `${key}${sep}[redacted]`),
  ],
];

// Identifying details: masked in the exported report (the local log keeps them,
// it never leaves the machine unless the user sends it).
const loopback = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i;
const IDENTITY_RULES = [
  [/\barn:aws[a-z-]*:[^\s"',)]+/g, '[arn]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/\b(https?|wss?):\/\/([^\s/"'<>]+)/gi, (m, scheme, host) => (loopback.test(host) ? m : `${scheme}://[host]`)],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:[a-z0-9-]+\.)+(?:eks\.amazonaws\.com|amazonaws\.com|azmk8s\.io|azure\.com|windows\.net|googleapis\.com|gke\.goog)\b/gi, '[host]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (m.startsWith('127.') ? m : '[ip]')],
  [/\b\d{12}\b/g, '[account]'],
];

const applyRules = (text, rules) => rules.reduce((out, [re, rep]) => out.replace(re, rep), String(text ?? ''));

/** `text` without credentials (tokens, keys, passwords, JWTs). */
const scrubSecrets = (text) => applyRules(text, SECRET_RULES);

/** `text` without credentials, endpoints, IPs, account/subscription IDs, emails or the home folder. */
function maskForReport(text, { home = os.homedir() } = {}) {
  let out = applyRules(scrubSecrets(text), IDENTITY_RULES);
  if (home && home.length > 3) out = out.split(home).join('~');
  return out;
}

const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

/**
 * Append-only log with size-based rotation. `write(source, text)` takes raw
 * output (any number of lines) and never throws: logging must not break the app.
 */
function createLogFile(dir, { name = LOG_NAME, maxBytes = MAX_BYTES, keep = KEEP, now = () => new Date() } = {}) {
  const file = path.join(dir, name);
  let size = 0;
  let ready = false;
  const open = () => {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      size = sizeOf(file);
      ready = true;
    } catch { /* no log folder: logging stays off */ }
    return ready;
  };
  const rotate = () => {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try { fs.renameSync(from, `${file}.${i}`); } catch { /* missing */ }
    }
    size = 0;
  };
  return {
    file,
    dir,
    write(source, text) {
      if (!open()) return;
      const stamp = now().toISOString();
      const lines = String(text ?? '')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `${stamp} [${source}] ${scrubSecrets(l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l)}\n`)
        .join('');
      if (!lines) return;
      try {
        const bytes = Buffer.byteLength(lines);
        if (size > 0 && size + bytes > maxBytes) rotate();
        fs.appendFileSync(file, lines, { mode: 0o600 });
        size += bytes;
      } catch { /* disk full, permissions: skip */ }
    },
    /** The last `bytes` of the log, oldest first (across the newest rotated file). */
    tail(bytes = 256 * 1024) {
      const parts = [];
      let left = bytes;
      for (const f of [file, `${file}.1`]) {
        if (left <= 0) break;
        try {
          // Size from the open file itself, so a rotation in between can't mismatch it.
          const fd = fs.openSync(f, 'r');
          try {
            const { size } = fs.fstatSync(fd);
            const len = Math.min(size, left);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            parts.unshift(buf.toString('utf8'));
            left -= len;
          } finally { fs.closeSync(fd); }
        } catch { /* missing */ }
      }
      const text = parts.join('');
      // Drop a partial first line.
      return bytes < sizeOf(file) + sizeOf(`${file}.1`) ? text.slice(text.indexOf('\n') + 1) : text;
    },
  };
}

/** Settings → their shape only: booleans and numbers as they are, everything else described. */
function settingsShape(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length} item${v.length === 1 ? '' : 's'}]`;
    else if (v && typeof v === 'object') out[k] = `{${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}}`;
    else if (v === null || v === undefined || v === '') out[k] = v ?? null;
    else out[k] = '(set)';
  }
  return out;
}

/** The text of an exported diagnostics file. */
function diagnosticsReport({ app = {}, system = {}, settings, log = '', now = new Date(), home = os.homedir() } = {}) {
  const lines = [
    'K8Board diagnostics',
    `Created: ${now.toISOString()}`,
    '',
    'Endpoints, IP addresses, account and subscription IDs, emails and credentials are masked.',
    'Review this file before you share it.',
    '',
    '== App',
    ...Object.entries(app).map(([k, v]) => `${k}: ${v}`),
    '',
    '== System',
    ...Object.entries(system).map(([k, v]) => `${k}: ${v}`),
    '',
    '== Settings (shape only, no values)',
    JSON.stringify(settingsShape(settings), null, 2),
    '',
    '== Log (most recent last)',
    // Only the log is masked: version numbers above would read as IP addresses.
    log ? maskForReport(log, { home }) : '(empty)',
    '',
  ];
  return lines.join('\n');
}

module.exports = { LOG_NAME, createLogFile, diagnosticsReport, maskForReport, scrubSecrets, settingsShape };
