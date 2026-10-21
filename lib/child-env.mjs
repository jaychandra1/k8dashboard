// Environment for processes KubePilot starts (kubectl and its credential
// plugins, az, trivy, terminals, external launchers).
//
// They get the user's environment — cloud SDK variables, proxies, PATH, the
// AI agent CLIs' own API keys — but never KubePilot's own secrets: the API
// token (and its legacy names), the at-rest secret key, the MCP token and the
// assistant's LLM key. Any of those in a child's environment can be read by
// every exec-credential plugin, wrapper script or agent it runs in turn.
const APP_SECRETS = /^(?:(?:KUBEPILOT|K8DASHBOARD|K8SIGHT)_(?:TOKEN|SECRET_KEY|MCP_TOKEN)|MCP_API_TOKEN|LLM_API_KEY)$/i;

/** Is `name` one of KubePilot's own secrets? (Case-insensitive: Windows env names are.) */
export const isAppSecretEnv = (name) => APP_SECRETS.test(String(name));

/** A copy of `env` without KubePilot's own secrets, plus `extra`. */
export function childEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== undefined && !isAppSecretEnv(k)) out[k] = v;
  }
  return Object.assign(out, extra);
}
