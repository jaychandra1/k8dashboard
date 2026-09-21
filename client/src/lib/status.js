// ONE canonical status → tone map. Every view must use this instead of its own
// running/pending/failed switch. Tones map to the .tone-* / .bg-tone-* classes
// in App.css and to <Badge tone>.

/** @typedef {'ok'|'warn'|'bad'|'muted'|'info'} Tone */

export const TONES = ['ok', 'warn', 'bad', 'muted', 'info'];

const OK = ['running', 'ready', 'bound', 'active', 'succeeded', 'completed', 'complete', 'healthy', 'synced', 'deployed', 'available', 'true', 'normal', 'connected', 'passed', 'pass', 'ok'];
const WARN = ['pending', 'containercreating', 'podinitializing', 'terminating', 'progressing', 'unknown', 'outofsync', 'suspended', 'waiting', 'warning', 'pending-install', 'pending-upgrade', 'pending-rollback', 'released', 'medium', 'low', 'scaling', 'updating', 'reconciling'];
const BAD = ['failed', 'crashloopbackoff', 'error', 'imagepullbackoff', 'errimagepull', 'oomkilled', 'evicted', 'notready', 'degraded', 'missing', 'false', 'invalidimagename', 'createcontainerconfigerror', 'createcontainererror', 'runcontainererror', 'deadlineexceeded', 'backoff', 'critical', 'high', 'fail', 'uninstalling', 'unhealthy', 'lost', 'unreachable', 'unauthorized', 'forbidden'];
const INFO = ['scheduled', 'created', 'started', 'pulling', 'pulled', 'info', 'initializing', 'superseded', 'uninstalled'];

const TONE_OF = new Map();
OK.forEach((s) => TONE_OF.set(s, 'ok'));
WARN.forEach((s) => TONE_OF.set(s, 'warn'));
BAD.forEach((s) => TONE_OF.set(s, 'bad'));
INFO.forEach((s) => TONE_OF.set(s, 'info'));

// Per-kind overrides where the same word means something different.
const KIND_OVERRIDES = {
  persistentvolume: { released: 'warn', available: 'info' },
  pv: { released: 'warn', available: 'info' },
  argocd: { progressing: 'info', missing: 'bad', suspended: 'muted' },
  argo: { progressing: 'info', missing: 'bad', suspended: 'muted' },
  node: { unknown: 'bad' },
  helm: { superseded: 'muted' },
  event: { warning: 'warn', normal: 'ok' },
};

/**
 * Map a status string (pod phase, condition, Helm status, Argo health…) to a tone.
 * `kind` is optional and only used for a few per-kind overrides. Callable as
 * `statusTone('pod', 'Running')` or `statusTone('Running')`.
 * @returns {Tone}
 */
export function statusTone(kind, status) {
  if (arguments.length === 1) { status = kind; kind = undefined; }
  if (status == null || status === '') return 'muted';
  const s = String(status).trim().toLowerCase();
  const k = kind ? String(kind).toLowerCase() : '';
  const ov = KIND_OVERRIDES[k];
  if (ov && ov[s]) return ov[s];
  if (TONE_OF.has(s)) return TONE_OF.get(s);
  // Compound reasons ("Init:CrashLoopBackOff", "Init:0/2", "ErrImageNeverPull").
  if (s.startsWith('init:')) {
    const rest = s.slice(5);
    return TONE_OF.get(rest) || 'warn';
  }
  if (/degrad/.test(s)) return 'bad';
  if (/backoff|err|fail|kill|evict|crash|unhealthy|notready|denied|timeout|invalid/.test(s)) return 'bad';
  if (/pending|creating|terminat|progress|waiting|initializ|unknown/.test(s)) return 'warn';
  return 'muted';
}

/** CSS class for a tone: 'tone-ok' etc. */
export function statusClass(tone) {
  return `tone-${TONES.includes(tone) ? tone : 'muted'}`;
}

/** Tinted-background variant: 'bg-tone-ok'. */
export function statusBgClass(tone) {
  return `bg-tone-${TONES.includes(tone) ? tone : 'muted'}`;
}

/** Convenience: className for a status string in one call. */
export function statusToneClass(kind, status) {
  return statusClass(arguments.length === 1 ? statusTone(kind) : statusTone(kind, status));
}

/**
 * Bucket a pod for the Overview / Cluster donuts. Accepts the summarised pod
 * shape returned by /api/resources ({ status, containerStatuses }) or a raw
 * V1Pod ({ status: { phase, containerStatuses } }).
 * @returns {'running'|'pending'|'failed'|'succeeded'|'unknown'}
 */
export function podPhaseBucket(pod) {
  if (!pod) return 'unknown';
  const raw = pod.status && typeof pod.status === 'object' ? pod.status.phase : (pod.status ?? pod.phase);
  const s = String(raw || '').toLowerCase();
  const containers = [].concat(pod.containerStatuses || pod.status?.containerStatuses || []);
  const reasons = containers
    .map((c) => (c.state?.waiting?.reason || c.state?.terminated?.reason || c.reason || ''))
    .map((r) => String(r).toLowerCase())
    .filter(Boolean);
  if (reasons.some((r) => BAD.includes(r))) return 'failed';
  if (s === 'running') return 'running';
  if (s === 'succeeded' || s === 'completed') return 'succeeded';
  if (BAD.includes(s)) return 'failed';
  if (WARN.includes(s) && s !== 'unknown') return 'pending';
  return 'unknown';
}

/** Tone for a pod bucket (donut segments, legends). */
export const BUCKET_TONE = { running: 'ok', pending: 'warn', failed: 'bad', succeeded: 'info', unknown: 'muted' };

/** Human label for a pod bucket. */
export const BUCKET_LABEL = { running: 'Running', pending: 'Pending', failed: 'Failed', succeeded: 'Succeeded', unknown: 'Unknown' };
