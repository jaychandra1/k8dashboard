// Sign-in gate for the kubeconfig's credential helpers (kubeconfig `exec`
// users: K8Board's EKS/Azure token helpers, aws-iam-authenticator, kubelogin…).
//
// @kubernetes/client-node runs the helper for every request that has no cached
// token, and caches successes only. When a sign-in ends (signed out, or the
// Identity Center session is over), every request of a busy page starts its
// own helper and each fails the same way — on Windows each one is a full start
// of the app runtime. The gate, wrapped around a KubeConfig's ExecAuth:
//   - shares one helper run between the requests that need it at the same time;
//   - marks a failed run as a sign-in problem (`err.clusterAuth`), its text
//     stripped of runtime log noise;
//   - remembers that user as needing a sign-in: later requests fail at once,
//     without a helper, until the block is cleared (an explicit auth check,
//     a reload, a finished sign-in).
// The server answers those requests with code `cluster_auth_required`, on which
// the UI opens its "session expired" dialog.

import { childEnv } from './child-env.mjs';

export const CLUSTER_AUTH_CODE = 'cluster_auth_required';
export const CLUSTER_AUTH_MESSAGE = 'Sign in again to use this cluster.';

const GATED = Symbol.for('k8board.execGate');

// Chromium log lines an Electron-based helper may print on stderr, e.g.
// "[7996:1106/160352.881:ERROR:net\disk_cache\cache_util_win.cc:25] Unable to move the cache: Access is denied. (0x5)".
const RUNTIME_LOG_LINE = /^\[\d+(?::\d+)?:\d{4}\/\d{6}(?:\.\d+)?:(?:VERBOSE\d*|INFO|WARNING|ERROR|FATAL)(?::[^\]]*)?\][^\n]*$/;

/** A helper's stderr without runtime log lines (the helper's own message stays). */
export function cleanHelperOutput(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !RUNTIME_LOG_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

/** Mark an error from a credential helper as "this cluster needs a sign-in". Mutates and returns it. */
export function asClusterAuthError(err) {
  const e = err instanceof Error ? err : new Error(String(err ?? 'The cluster sign-in helper failed.'));
  if (!e.clusterAuth) {
    const cleaned = cleanHelperOutput(e.message);
    if (cleaned !== e.message) {
      try { e.message = cleaned || 'The cluster sign-in helper failed.'; } catch { /* frozen: keep the text */ }
    }
    e.clusterAuth = true;
  }
  return e;
}

// A helper that never answers would otherwise hold every request for its user
// (they share its run). Generous, as some helpers open a browser sign-in.
export const HELPER_TIMEOUT_MS = 3 * 60 * 1000;

export function createExecGate({ timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const blocked = new Map(); // kubeconfig user name → the error that blocked it
  const keyOf = (name) => String(name ?? '');
  let stopHelpers = () => {}; // kills the running helpers of the attached KubeConfig

  return {
    /** Wrap `kc.execAuth` (once per KubeConfig). Returns `kc`. */
    attach(kc) {
      const execAuth = kc?.execAuth;
      if (!execAuth || typeof execAuth.getCredential !== 'function' || execAuth[GATED]) return kc;
      const original = execAuth.getCredential.bind(execAuth);
      const running = new Map(); // user name → in-flight credential promise
      // The helper processes ExecAuth starts, so a timeout or a disconnect can stop them.
      const live = new Set();
      if (typeof execAuth.execFn === 'function') {
        const spawnFn = execAuth.execFn;
        // ExecAuth passes no env (the child inherits process.env) unless the
        // kubeconfig entry sets one; either way K8Board's own secrets stay out.
        execAuth.execFn = (command, args, opts) => {
          const child = spawnFn(command, args, { ...opts, env: childEnv(opts?.env || process.env) });
          live.add(child);
          const done = () => live.delete(child);
          child?.once?.('close', done);
          child?.once?.('error', done);
          return child;
        };
      }
      const killAll = () => { for (const child of live) { try { child.kill(); } catch { /* gone */ } } };
      stopHelpers = killAll;
      execAuth.getCredential = (user) => {
        const key = keyOf(user?.name);
        const stop = blocked.get(key);
        if (stop) return Promise.reject(stop);
        const inFlight = running.get(key);
        if (inFlight) return inFlight;
        // Not unref'd: it must fire even when nothing else keeps the process
        // busy. It only exists while a helper runs (cleared when the run ends).
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            killAll();
            reject(new Error(`The cluster's sign-in helper didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
          }, timeoutMs);
        });
        const run = Promise.race([Promise.resolve().then(() => original(user)), timeout])
          .catch((err) => {
            const e = asClusterAuthError(err);
            blocked.set(key, e);
            throw e;
          })
          .finally(() => { clearTimeout(timer); running.delete(key); });
        running.set(key, run);
        return run;
      };
      execAuth[GATED] = true;
      return kc;
    },
    /** Stop the helpers running now (Disconnect / Cancel): their runs fail and end. */
    stopAll() { stopHelpers(); },
    /** Make `name`'s requests fail at once with `err` (e.g. after signing it out). */
    block(name, err) { blocked.set(keyOf(name), asClusterAuthError(err)); },
    /** Lift the block of one user, or of all users when called without a name. */
    clear(name) {
      if (arguments.length === 0) blocked.clear();
      else blocked.delete(keyOf(name));
    },
    blockedError: (name) => blocked.get(keyOf(name)) || null,
  };
}
