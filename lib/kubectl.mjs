// Async child-process helpers: executable lookup (with Windows PATHEXT), a
// kubectl runner that always pins --context and --request-timeout, and a
// `positional()` helper that puts user-supplied values behind `--` so they
// can never be parsed as flags. Nothing here is synchronous on request paths.
import { spawn } from 'child_process';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IS_WIN = process.platform === 'win32';

// ------------------------------------------------------------------
// PATH resolution
// ------------------------------------------------------------------
// A GUI-launched app inherits a minimal PATH and a login shell (`-lc`) sources
// ~/.zprofile but NOT ~/.zshrc — where installers like Claude Code's add
// ~/.local/bin. So we search the process PATH, the login-shell PATH and a set
// of well-known bin directories.
let loginPathCache;
export const loginShellPath = () => new Promise((resolve) => {
  if (loginPathCache !== undefined) return resolve(loginPathCache);
  if (IS_WIN) return resolve((loginPathCache = ''));
  execFile(process.env.SHELL || '/bin/sh', ['-lc', 'printf %s "$PATH"'], { timeout: 8000 }, (err, stdout) => {
    resolve((loginPathCache = (!err && stdout ? String(stdout).trim() : '')));
  });
});

export const knownBinDirs = () => {
  const home = process.env.HOME || os.homedir();
  if (IS_WIN) {
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(la, 'Programs', 'bin'),
      path.join(la, 'Microsoft', 'WinGet', 'Links'), path.join(pf, 'Docker', 'Docker', 'resources', 'bin'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
      path.join(pf, 'Kubernetes'), 'C:\\ProgramData\\chocolatey\\bin',
    ];
  }
  return [
    `${home}/.local/bin`, `${home}/bin`, `${home}/.npm-global/bin`,
    `${home}/.yarn/bin`, `${home}/.bun/bin`, `${home}/.deno/bin`, `${home}/.cargo/bin`,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
};

const SAFE_CMD = /^[a-zA-Z0-9_.-]+$/;
const winExts = () => {
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return ['', ...exts];
};

const isExecutable = (p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
};

const candidateFiles = (dir, name) => {
  if (!IS_WIN) return [path.join(dir, name)];
  const hasExt = /\.[a-z0-9]{1,4}$/i.test(name);
  return (hasExt ? [''] : winExts()).map((ext) => path.join(dir, name + ext));
};

const searchDirs = (extra = '') => [
  ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
  ...(extra ? extra.split(path.delimiter) : []),
  ...knownBinDirs(),
].filter(Boolean);

// Resolve an executable to an ABSOLUTE path (sync; results memoized briefly so
// a freshly installed CLI is picked up without a restart). Falls back to the
// bare name so plain PATH lookup can still try.
const resolveCache = new Map(); // name -> { path, at }
export const resolveBinSync = (cmd) => {
  const safe = String(cmd);
  if (!SAFE_CMD.test(safe)) return cmd;
  const hit = resolveCache.get(safe);
  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  let found = cmd;
  outer: for (const dir of searchDirs(loginPathCache || '')) {
    for (const p of candidateFiles(dir, safe)) {
      if (isExecutable(p)) { found = p; break outer; }
    }
  }
  resolveCache.set(safe, { path: found, at: Date.now() });
  return found;
};

export const commandExists = async (cmd) => {
  const safe = String(cmd);
  if (!SAFE_CMD.test(safe)) return false;
  const extra = await loginShellPath();
  for (const dir of new Set(searchDirs(extra))) {
    for (const p of candidateFiles(dir, safe)) if (isExecutable(p)) return true;
  }
  return false;
};

// ------------------------------------------------------------------
// Spawning
// ------------------------------------------------------------------
// Windows batch launchers (az.cmd, helm.cmd from some installers) can only run
// through cmd.exe, which re-parses the command line. We allow that ONLY for
// arguments that contain no cmd metacharacters, quoted defensively.
const CMD_UNSAFE = /["%!^&|<>\r\n]/;
const winQuote = (s) => (/[\s]/.test(s) || s === '' ? `"${s}"` : s);

export function spawnBin(bin, args, opts = {}) {
  const resolved = resolveBinSync(bin);
  const list = (args || []).map((a) => String(a));
  if (IS_WIN && /\.(cmd|bat)$/i.test(resolved)) {
    for (const a of list) if (CMD_UNSAFE.test(a)) throw new Error(`Refusing to pass an unsafe argument to ${path.basename(resolved)}`);
    const line = `"${[resolved, ...list].map(winQuote).join(' ')}"`;
    return spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true, windowsHide: true });
  }
  return spawn(resolved, list, { windowsHide: true, ...opts });
}

// Collect a child's output with a hard timeout and an output cap. Resolves
// { code, signal, stdout, stderr } — it never rejects on a non-zero exit so
// callers that need the exit code (exec) can inspect it.
export function collectChild(child, { input, timeoutMs = 25000, maxBuffer = 10 * 1024 * 1024, label = 'process' } = {}) {
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    let outLen = 0, errLen = 0, settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxBuffer) { kill(); return finish(() => reject(Object.assign(new Error(`${label} output exceeded ${maxBuffer} bytes`), { code: 'ENOBUFS' }))); }
      out.push(d);
    });
    child.stderr?.on('data', (d) => {
      if (errLen < 1024 * 1024) { err.push(d); errLen += d.length; }
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code, signal) => finish(() => resolve({
      code, signal,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    })));
    if (child.stdin) {
      // kubectl may exit before reading stdin (usage error) → EPIPE; ignore.
      child.stdin.on('error', () => {});
      if (input != null) child.stdin.end(input); else child.stdin.end();
    }
  });
}

// `--` terminator: everything after it is positional, never a flag.
export const positional = (...values) => {
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) throw new TypeError('positional() values must be non-empty strings');
  }
  return ['--', ...values];
};

// Build the context-bound kubectl runner. `getContext` is read on every call so
// in-memory context switches are always honoured.
export function createKubectl({ getContext, bin = 'kubectl' } = {}) {
  const contextArgs = () => {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    return ctx ? [`--context=${ctx}`] : [];
  };
  const baseArgs = (timeoutMs, requestTimeout) => {
    const rt = requestTimeout ?? Math.max(5, Math.ceil(timeoutMs / 1000));
    return [...contextArgs(), `--request-timeout=${rt}s`];
  };

  // Long-lived kubectl child (port-forward). Context is pinned; no request
  // timeout is applied — the caller owns the process lifetime.
  const spawnKubectl = (args, opts = {}) =>
    spawnBin(bin, [...contextArgs(), ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...opts });

  // Raw run: resolves { code, stdout, stderr } (non-zero exit does NOT reject).
  const execKubectl = async (args, { input, timeoutMs = 25000, maxBuffer = 10 * 1024 * 1024, requestTimeout } = {}) => {
    for (const a of args) if (typeof a !== 'string') throw new TypeError('kubectl args must be strings');
    const child = spawnBin(bin, [...baseArgs(timeoutMs, requestTimeout), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    return collectChild(child, { input, timeoutMs, maxBuffer, label: 'kubectl' });
  };

  // Run and resolve trimmed stdout; rejects with an Error carrying
  // { code, stderr, stdout } on non-zero exit.
  const runKubectl = async (args, opts = {}) => {
    const r = await execKubectl(args, opts);
    if (r.code === 0) return r.stdout.trim();
    const msg = (r.stderr || r.stdout || `kubectl exited ${r.code ?? r.signal}`).trim();
    throw Object.assign(new Error(msg), { code: r.code, signal: r.signal, stderr: r.stderr, stdout: r.stdout });
  };

  const runKubectlJson = async (args, opts = {}) => {
    const out = await runKubectl(args, opts);
    return out ? JSON.parse(out) : {};
  };

  return { runKubectl, runKubectlJson, execKubectl, spawnKubectl };
}
