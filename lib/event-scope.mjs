// Which events belong to a workload, and the Events page's filters. Shared by
// server.js (real clusters) and demo.js.
//
// A Deployment's own events are few ("Scaled up replica set …"); the ones that
// explain a problem (BackOff, FailedScheduling, Unhealthy, FailedMount) are on
// its ReplicaSets and Pods. So a workload's scope is the workload, what it owns
// (Deployment → ReplicaSets → Pods, CronJob → Jobs → Pods, StatefulSet /
// DaemonSet / Job → Pods), the autoscaler pointing at it — and, by their
// generated names, the ReplicaSets / Pods / Jobs a rollout already deleted:
// events outlive their objects (about an hour), and those are often the ones
// that say why a rollout went wrong. Matching is by kind + name (an event's
// involvedObject), not uid, for that reason.

// Characters Kubernetes uses in generated suffixes (pod-template-hash and the
// 5-character pod / job suffix): no vowels, no 0/1/3 — so "web-api" is not
// mistaken for a ReplicaSet of "web".
const GEN = '[bcdfghjklmnpqrstvwxz2456789]';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kinds the Events page can scope to (the workload kinds, and a single Pod). */
export const SCOPE_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'];

const ownedBy = (obj, kind, name) => (obj?.metadata?.ownerReferences || []).some((o) => o.kind === kind && o.name === name);
const nameOf = (obj) => obj?.metadata?.name;

/**
 * The objects whose events belong to `kind/name`, from the lists of that
 * namespace (raw Kubernetes objects; any list may be missing):
 * → { refs: Set<"Kind/name">, patterns: [{ kind, re }] }
 */
export function workloadScope({ kind, name }, { replicaSets = [], pods = [], jobs = [], hpas = [] } = {}) {
  const refs = new Set([`${kind}/${name}`]);
  const patterns = [];
  const podsOf = (ownerKind, ownerName) => pods.filter((p) => ownedBy(p, ownerKind, ownerName)).forEach((p) => refs.add(`Pod/${nameOf(p)}`));
  const n = esc(name);
  switch (kind) {
    case 'Deployment':
      for (const rs of replicaSets.filter((r) => ownedBy(r, 'Deployment', name))) {
        refs.add(`ReplicaSet/${nameOf(rs)}`);
        podsOf('ReplicaSet', nameOf(rs));
      }
      patterns.push({ kind: 'ReplicaSet', re: new RegExp(`^${n}-${GEN}{1,10}$`) });
      patterns.push({ kind: 'Pod', re: new RegExp(`^${n}-${GEN}{1,10}-${GEN}{5}$`) });
      break;
    case 'StatefulSet':
      podsOf('StatefulSet', name);
      patterns.push({ kind: 'Pod', re: new RegExp(`^${n}-\\d+$`) });
      // volumeClaimTemplates: <template>-<statefulset>-<ordinal>
      patterns.push({ kind: 'PersistentVolumeClaim', re: new RegExp(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?-${n}-\\d+$`) });
      break;
    case 'DaemonSet':
      podsOf('DaemonSet', name);
      patterns.push({ kind: 'Pod', re: new RegExp(`^${n}-${GEN}{5}$`) });
      break;
    case 'Job':
      podsOf('Job', name);
      patterns.push({ kind: 'Pod', re: new RegExp(`^${n}-${GEN}{5}$`) });
      break;
    case 'CronJob':
      for (const j of jobs.filter((x) => ownedBy(x, 'CronJob', name))) {
        refs.add(`Job/${nameOf(j)}`);
        podsOf('Job', nameOf(j));
      }
      // Jobs are <cronjob>-<scheduled time in minutes>.
      patterns.push({ kind: 'Job', re: new RegExp(`^${n}-\\d{6,}$`) });
      patterns.push({ kind: 'Pod', re: new RegExp(`^${n}-\\d{6,}-${GEN}{5}$`) });
      break;
    default: // Pod: just itself
      break;
  }
  for (const h of hpas) {
    const t = h?.spec?.scaleTargetRef;
    if (t?.kind === kind && t?.name === name) refs.add(`HorizontalPodAutoscaler/${nameOf(h)}`);
  }
  return { refs, patterns };
}

/** Is the object `kind/name` in the scope? */
export function inScope(scope, kind, name) {
  return scope.refs.has(`${kind}/${name}`) || scope.patterns.some((p) => p.kind === kind && p.re.test(name));
}

/** "Kind/name" → { kind, name } (names never contain "/"). */
export function splitObject(ref) {
  const s = String(ref || '');
  const i = s.indexOf('/');
  return i < 0 ? { kind: '', name: s } : { kind: s.slice(0, i), name: s.slice(i + 1) };
}

/**
 * The Events page's filters over event rows ({ type, reason, message,
 * namespace, involvedObject: "Kind/name", source }):
 *   type: 'Warning' | 'Normal' | '' · q: text in message / reason / object /
 *   namespace / source · namespaces: [ns] · scope: workloadScope(…)
 */
export function filterEvents(events, { type, q, namespaces, scope } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const nsSet = namespaces?.length ? new Set(namespaces) : null;
  return (events || []).filter((e) => {
    if (type && e.type !== type) return false;
    if (nsSet && !nsSet.has(e.namespace)) return false;
    if (scope) {
      const { kind, name } = splitObject(e.involvedObject);
      if (!inScope(scope, kind, name)) return false;
    }
    if (needle) {
      const hay = `${e.message || ''}\n${e.reason || ''}\n${e.involvedObject || ''}\n${e.namespace || ''}\n${e.source || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** "Deployment/frontend" → { kind, name } when it names a scope kind and a valid name, else null. */
export function parseWorkload(s) {
  const { kind, name } = splitObject(s);
  if (!SCOPE_KINDS.includes(kind)) return null;
  if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name)) return null;
  return { kind, name };
}
