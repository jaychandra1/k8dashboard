// Helm terminal (Helm page → "+ Helm terminal"): a shell on the user's own
// machine where `helm` and `kubectl` can reach ONLY the cluster selected in
// KubePilot. The pure pieces live here so they can be tested; server.js wires
// them into the /ws/exec PTY bridge (`?shell=helm`).
//
//  * Pinned cluster: the shell's KUBECONFIG is a temporary file holding just
//    the selected context (its cluster + user), so `--kube-context other` or a
//    stray `kubectl config use-context` cannot reach another cluster.
//  * Clean shell: no profile / rc files (they often export KUBECONFIG and would
//    silently undo the pinning); PATH comes from the app, which already merged
//    the login shell's PATH. The prompt names the cluster.
//  * Allowlisted environment: no KubePilot secrets (API token, secret key) leak
//    into the shell.
//  * Desktop only: in the desktop app the server runs on the user's machine.
//    Behind Docker / a shared server the "terminal" would be a shell inside the
//    server, so it is off unless KUBEPILOT_LOCAL_SHELL=1 opts in.
import path from 'node:path';

/** May this server open a shell on its own host for the Helm terminal? */
export function localShellAllowed({ env = process.env, versions = process.versions } = {}) {
  return Boolean(versions?.electron) || env.KUBEPILOT_LOCAL_SHELL === '1';
}

/**
 * A kubeconfig (JSON, which kubectl and helm read like YAML) with only
 * `contextName`, its cluster and its user. `namespace` (optional) becomes the
 * context's default namespace. Throws when the context does not exist.
 */
export function pinnedKubeconfig(kubeConfig, contextName, KubeConfigClass, namespace) {
  const ctx = contextName ? kubeConfig.getContextObject(contextName) : null;
  if (!ctx) throw new Error(`context "${contextName || ''}" is not in the kubeconfig`);
  const cluster = kubeConfig.getCluster(ctx.cluster);
  if (!cluster) throw new Error(`cluster "${ctx.cluster}" of context "${ctx.name}" is not in the kubeconfig`);
  const user = ctx.user ? kubeConfig.getUser(ctx.user) : null;
  const pinned = new KubeConfigClass();
  pinned.loadFromOptions({
    clusters: [cluster],
    users: user ? [user] : [],
    contexts: [{ ...ctx, ...(namespace ? { namespace } : {}) }],
    currentContext: ctx.name,
  });
  return pinned.exportConfig();
}

/** Short cluster label for the prompt: "arn:aws:eks:…:cluster/dev" → "dev". */
export const clusterLabel = (contextName) => String(contextName || '').split('/').pop() || 'cluster';

// Variables the shell, helm and cloud credential plugins need. Everything else
// (notably KUBEPILOT_* — the API token, the secrets key) stays out.
const ENV_EXACT = new Set([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME', 'USERDOMAIN', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
]);
const ENV_PREFIX = /^(AWS_|AZURE_|GOOGLE_|CLOUDSDK_|HELM_)/;
// Windows variable names are case-insensitive (and arrive as e.g. SYSTEMROOT
// from Git Bash) — PowerShell refuses to start without SystemRoot.
const ENV_EXACT_LOWER = new Set([...ENV_EXACT].map((k) => k.toLowerCase()));
const allowed = (k, win) => (win
  ? ENV_EXACT_LOWER.has(k.toLowerCase()) || ENV_PREFIX.test(k.toUpperCase())
  : ENV_EXACT.has(k) || ENV_PREFIX.test(k));

/**
 * The shell's environment: the allowlist above plus the pinning —
 * KUBECONFIG (the temp file), HELM_KUBECONTEXT, HELM_NAMESPACE (when given)
 * and KP_CLUSTER (for the prompt). `helmDir` (where helm was found, if not on
 * PATH, e.g. just installed with winget) is put first on PATH.
 */
export function helmShellEnv(base, { kubeconfigPath, context, namespace, helmDir, platform = process.platform }) {
  const win = platform === 'win32';
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined || k.toUpperCase().startsWith('KUBEPILOT_')) continue;
    if (allowed(k, win)) env[k] = v;
  }
  // Drop any spelling of the pinned variables before setting them.
  if (win) for (const k of Object.keys(env)) if (/^(kubeconfig|helm_kubecontext|helm_namespace)$/i.test(k)) delete env[k];
  const pathKey = (win && Object.keys(env).find((k) => k.toUpperCase() === 'PATH')) || 'PATH';
  const sep = win ? ';' : ':';
  if (helmDir) {
    const parts = String(env[pathKey] || '').split(sep).filter(Boolean);
    if (!parts.includes(helmDir)) env[pathKey] = [helmDir, ...parts].join(sep);
  }
  env.TERM = 'xterm-256color';
  env.KUBECONFIG = kubeconfigPath;
  env.HELM_KUBECONTEXT = context;
  if (namespace) env.HELM_NAMESPACE = namespace;
  else delete env.HELM_NAMESPACE;
  env.KP_CLUSTER = clusterLabel(context);
  return env;
}

/**
 * The shell to start: PowerShell on Windows (no profile; prompt shows the
 * cluster), otherwise bash without profile/rc files (zsh's -f equivalent when
 * bash is missing). `exists(file)` checks a path.
 */
export function helmShellCommand({ platform = process.platform, exists = () => true } = {}) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "function global:prompt { '[helm:' + $env:KP_CLUSTER + '] ' + (Get-Location).Path + '> ' }"],
      env: {},
    };
  }
  // PS1 references the variable (expanded once at display time), so a
  // context name can never be evaluated as shell code.
  const PS1 = '[helm:${KP_CLUSTER}] \\W \\$ ';
  if (exists('/bin/bash')) return { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'], env: { PS1 } };
  if (exists('/bin/zsh')) return { file: '/bin/zsh', args: ['-f', '-i'], env: { PS1: '[helm:${KP_CLUSTER}] %1~ %# ' } };
  return { file: '/bin/sh', args: ['-i'], env: { PS1: '[helm] $ ' } };
}

const CYAN = (s) => `\x1b[1;36m${s}\x1b[0m`;
const DIM = (s) => `\x1b[90m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

/** Install hint for a missing helm, per OS. */
export const helmInstallHint = (platform = process.platform) =>
  platform === 'win32'
    ? 'winget install Helm.Helm'
    : platform === 'darwin'
      ? 'brew install helm'
      : 'see https://helm.sh/docs/intro/install/';

/** The lines shown above the prompt. */
export function helmShellBanner({ context, namespace, helmFound, platform = process.platform }) {
  const lines = [
    `${CYAN('Helm terminal')} ${DIM('·')} cluster ${CYAN(clusterLabel(context))}${namespace ? ` ${DIM('·')} namespace ${CYAN(namespace)}` : ''}`,
    DIM(`helm and kubectl here can only reach ${context} (a temporary kubeconfig with just this context, deleted when you close the terminal).`),
  ];
  if (helmFound) {
    lines.push(DIM('Example: helm repo add aqua https://aquasecurity.github.io/helm-charts/'));
    lines.push(DIM('         helm install trivy-operator aqua/trivy-operator -n trivy-system --create-namespace'));
  } else {
    lines.push(YELLOW(`helm is not installed on this machine. Install it with: ${helmInstallHint(platform)} — then reopen this terminal.`));
  }
  return `\r\n${lines.join('\r\n')}\r\n\r\n`;
}

/** Directory of a resolved helm binary, or null when it was not found (bare name). */
export const helmDirOf = (resolved) => (resolved && path.isAbsolute(resolved) ? path.dirname(resolved) : null);
