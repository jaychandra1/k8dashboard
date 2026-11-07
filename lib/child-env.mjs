// Environment for processes K8Board starts (kubectl and its credential
// plugins, az, trivy, terminals, external launchers).
//
// They get the user's environment — cloud SDK variables, proxies, PATH, the
// AI agent CLIs' own API keys — but never K8Board's own secrets: the API
// token (and its legacy names), the at-rest secret key, the MCP token and the
// assistant's LLM key. Any of those in a child's environment can be read by
// every exec-credential plugin, wrapper script or agent it runs in turn.
// Every prefix lib/paths.mjs reads settings from (ENV_PREFIXES), current and legacy.
const APP_SECRETS = /^(?:(?:K8BOARD|KUBEPILOT|K8DASHBOARD|K8SIGHT)_(?:TOKEN|SECRET_KEY|MCP_TOKEN)|MCP_API_TOKEN|LLM_API_KEY)$/i;

/** Is `name` one of K8Board's own secrets? (Case-insensitive: Windows env names are.) */
export const isAppSecretEnv = (name) => APP_SECRETS.test(String(name));

// K8Board's own secrets held out of this process's environment (holdAppSecrets).
// Keys are upper-cased on Windows, where environment names are case-insensitive.
const held = new Map();
const heldKey = (name) => (process.platform === 'win32' ? String(name).toUpperCase() : String(name));

/**
 * Move K8Board's own secrets out of `env` (this process's environment by
 * default) and keep them in memory, where appSecretEnv() reads them.
 *
 * Children that K8Board spawns itself already get childEnv(). But the
 * kubeconfig exec credential plugins (kubelogin, aws-iam-authenticator, custom
 * scripts…) are started by @kubernetes/client-node with process.env, and so is
 * anything a library spawns. Once the secrets are no longer in process.env,
 * no such process can inherit them. Returns the names removed.
 */
export function holdAppSecrets(env = process.env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    if (!isAppSecretEnv(name)) continue;
    const value = env[name];
    if (value !== undefined && value !== '') held.set(heldKey(name), String(value));
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/** `name` from the environment, else the value holdAppSecrets() took out of it. */
export function appSecretEnv(name) {
  const value = process.env[name];
  return value !== undefined ? value : held.get(heldKey(name));
}

/** A copy of `env` without K8Board's own secrets, plus `extra`. */
export function childEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== undefined && !isAppSecretEnv(k)) out[k] = v;
  }
  return Object.assign(out, extra);
}
