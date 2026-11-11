// Google GKE integration — discover the GKE clusters a Google account can see
// and write kubeconfig entries for them, with no gke-gcloud-auth-plugin: the
// entries exec K8Board's own gke-token.js helper, which asks gcloud for a
// token (lib/gcloud.mjs). Mirrors aws-eks.js / azure-aks.js.
//
// Google is asked two things, with the user's gcloud token: which projects the
// account can see (Cloud Resource Manager), and each project's clusters
// (Kubernetes Engine API). Nothing is written anywhere but the kubeconfig.
import { loadKube, saveKube, upsert } from './aws-eks.js';
import { execEntry } from './lib/paths.mjs';
import { cloudSignal } from './lib/net-timeouts.mjs';
import { isAccount } from './lib/gcloud.mjs';
import { execArg } from './lib/eks-kubeconfig.mjs';

const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const GKE = 'https://container.googleapis.com/v1';
// Project ids: lowercase letters, digits and hyphens (older ones may carry a
// "domain.com:" prefix). Cluster names and locations: the same alphabet.
const PROJECT_RE = /^[a-z0-9][a-z0-9.:-]{4,62}$/;
const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const isGkeRef = (c) => PROJECT_RE.test(String(c?.project || '')) && NAME_RE.test(String(c?.location || '')) && NAME_RE.test(String(c?.name || ''));
export const gkeKey = (c) => `${c.project}/${c.location}/${c.name}`;

/** Google's answer was not usable: `code` says how (auth | forbidden | unavailable). */
export class GkeApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GkeApiError';
    this.code = code;
    this.status = status;
  }
}

async function getJson(url, token, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: cloudSignal() });
  } catch (e) {
    throw new GkeApiError('unavailable', `Google Cloud could not be reached (${e?.name === 'TimeoutError' ? 'it took too long' : 'network error'}).`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* an empty or non-JSON body */
  }
  if (res.ok) return body || {};
  const message = String(body?.error?.message || '').split('\n')[0];
  if (res.status === 401) throw new GkeApiError('auth', 'Your Google sign-in has expired. Sign in with Google again.', 401);
  if (res.status === 403 || res.status === 404) throw new GkeApiError('forbidden', message || 'Not allowed', res.status);
  throw new GkeApiError('unavailable', `Google Cloud answered ${res.status}${message ? `: ${message}` : ''}.`, res.status);
}

/** The active projects the account can see: [{ projectId, name }]. */
export async function listProjects(token, { fetchImpl = globalThis.fetch, max = 2000 } = {}) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ filter: 'lifecycleState:ACTIVE', pageSize: '500', ...(pageToken ? { pageToken } : {}) });
    const page = await getJson(`${CRM}/projects?${q}`, token, fetchImpl);
    for (const p of page.projects || []) if (PROJECT_RE.test(String(p.projectId || ''))) out.push({ projectId: p.projectId, name: p.name || p.projectId });
    pageToken = page.nextPageToken || '';
  } while (pageToken && out.length < max);
  return out;
}

const clusterOf = (project, c) => ({
  project: project.projectId,
  projectName: project.name,
  name: c.name,
  location: c.location || c.zone,
  endpoint: c.endpoint || null,
  caData: c.masterAuth?.clusterCaCertificate || null,
  status: c.status || '',
  version: c.currentMasterVersion || '',
  // No public endpoint: reachable only from the cluster's network (VPN).
  private: !!c.privateClusterConfig?.enablePrivateEndpoint,
});

/**
 * Every GKE cluster of every project the token can see. A project where the
 * Kubernetes Engine API is off, or the account may not list clusters, is
 * skipped and counted, not an error. → { clusters, projects, skipped }
 */
export async function discoverGkeClusters({ token, fetchImpl = globalThis.fetch, concurrency = 8 } = {}) {
  const projects = await listProjects(token, { fetchImpl });
  const clusters = [];
  let skipped = 0;
  let next = 0;
  const worker = async () => {
    while (next < projects.length) {
      const project = projects[next++];
      try {
        const body = await getJson(`${GKE}/projects/${encodeURIComponent(project.projectId)}/locations/-/clusters`, token, fetchImpl);
        for (const c of body.clusters || []) {
          const item = clusterOf(project, c);
          if (isGkeRef(item)) clusters.push(item);
        }
      } catch (e) {
        if (e?.code === 'auth') throw e;
        skipped += 1; // API not enabled, no permission, or a project that did not answer
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length || 1) }, worker));
  clusters.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
  return { clusters, projects: projects.length, skipped };
}

/**
 * What a kubeconfig context's GKE entry names: { project, location, cluster,
 * account }, read from the exec args K8Board's helper entry carries. null when
 * the context isn't one K8Board wrote for GKE. `kc` is a client-node KubeConfig.
 */
export function gkeEntryFor(kc, name) {
  const ctx = (kc?.contexts || []).find((c) => c.name === name);
  const user = ctx ? (kc?.users || []).find((u) => u.name === ctx.user) : null;
  const args = Array.isArray(user?.exec?.args) ? user.exec.args.map(String) : [];
  const isHelper = args.some((a) => /(^|[\\/])gke-token\.js$/i.test(a)) || (args.includes('--token-helper') && args[args.indexOf('--token-helper') + 1] === 'gke');
  if (!isHelper) return null;
  return { project: execArg(args, '--project'), location: execArg(args, '--location'), cluster: execArg(args, '--cluster'), account: execArg(args, '--account') };
}
const sameGkeCluster = (entry, c) => !!entry && entry.project === c.project && entry.location === c.location && entry.cluster === c.name;

/**
 * Each discovered cluster with its relation to the kubeconfig: `imported`
 * (this cluster is already there), `conflict` (another cluster has its name),
 * and never its endpoint or certificate.
 */
export function gkeClusterStatus(kc, clusters) {
  return clusters.map((c) => {
    const entry = gkeEntryFor(kc, c.name);
    const taken = (kc?.contexts || []).some((x) => x.name === c.name);
    return {
      project: c.project, projectName: c.projectName, name: c.name, location: c.location, status: c.status, version: c.version, private: c.private,
      imported: sameGkeCluster(entry, c),
      conflict: taken && !sameGkeCluster(entry, c),
    };
  });
}

/** Write a cluster/user/context for one GKE cluster; returns the context name. */
export function writeGkeCluster({ cluster, account }) {
  if (!isGkeRef(cluster)) throw new Error('Missing or invalid cluster name, project or location');
  if (!cluster.endpoint || !cluster.caData) throw new Error('Google did not report this cluster\'s endpoint or certificate (is it still being created?)');
  if (account != null && !isAccount(account)) throw new Error('Invalid Google account');
  const ctxName = cluster.name;
  const { p, doc } = loadKube();
  upsert(doc.clusters, ctxName, { name: ctxName, cluster: { server: `https://${cluster.endpoint}`, 'certificate-authority-data': cluster.caData } });
  // Packaged app: `K8Board --token-helper gke …`; source/Docker: `node gke-token.js …`.
  // The account pins which Google sign-in the token comes from; the other flags
  // only record which cluster the entry is for (gkeEntryFor).
  const helper = execEntry('gke', [
    ...(account ? ['--account', account] : []),
    '--project', cluster.project, '--location', cluster.location, '--cluster', cluster.name,
  ]);
  upsert(doc.users, ctxName, {
    name: ctxName,
    user: {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1',
        command: helper.command,
        args: helper.args,
        ...(helper.env ? { env: helper.env } : {}),
        interactiveMode: 'Never',
        provideClusterInfo: false,
      },
    },
  });
  upsert(doc.contexts, ctxName, { name: ctxName, context: { cluster: ctxName, user: ctxName } });
  saveKube(p, doc);
  return ctxName;
}
