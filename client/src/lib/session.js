// The cluster this window is connected to, remembered for the life of the
// window (sessionStorage). A reload — Ctrl+R, Ctrl+Shift+R, F5 — then comes
// back to the same cluster and page instead of Home (App.jsx, "a reload inside
// a cluster").
//
// It is only a note of what the user already did in this window: a new window,
// or the app started again, has nothing remembered and opens on Home, where
// nothing connects until the user picks a cluster. The name is not a secret
// (it is the kubeconfig context the title bar already shows).
const KEY = 'k8board.connected';

/** Note the cluster this window is connected to. */
export function rememberConnection(context) {
  try {
    if (context) sessionStorage.setItem(KEY, String(context));
  } catch {
    /* storage unavailable: a reload opens Home, as before */
  }
}

/** The cluster this window was connected to before it reloaded, or null. */
export function rememberedConnection() {
  try {
    return sessionStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Disconnected (or the connection is gone): a reload opens Home. */
export function forgetConnection() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
