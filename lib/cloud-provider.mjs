// Which cloud (or local tool) runs a cluster, from its API server URL. Only the
// host name and port count: a path, query or userinfo that mentions a cloud
// domain never changes the answer.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', 'host.docker.internal', 'kubernetes.docker.internal']);
const LOCAL_TOOLS = ['minikube', 'kind', 'orbstack', 'rancher', 'docker-desktop'];
const LOCAL_PORTS = new Set(['6443', '8443']);

/** The URL's { host, port }, or null when it doesn't parse. A bare host gets https://. */
export function serverHost(server) {
  const raw = String(server || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

/** 'azure' | 'aws' | 'gcp' | 'local' | 'other' */
export function providerOfServer(server) {
  const parsed = serverHost(server);
  if (!parsed) return 'other';
  const { host, port } = parsed;
  const labels = host.split('.');
  const under = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (under('azmk8s.io') || labels.includes('azure')) return 'azure';
  if (labels.includes('eks')) return 'aws';
  if (labels.includes('gke') || under('gke.goog') || under('container.googleapis.com')) return 'gcp';
  if (LOCAL_HOSTS.has(host) || LOCAL_PORTS.has(port) || LOCAL_TOOLS.some((t) => host.includes(t))) return 'local';
  return 'other';
}
