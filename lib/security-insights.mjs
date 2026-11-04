// Security Center insight on top of the Trivy Operator's reports — pure
// functions (no I/O) so server.js stays thin and they can be unit-tested:
//
//   • scan coverage: which images running in the cluster have a vulnerability
//     report yet, which are being scanned now, and which scans failed — the
//     operator scans one (workload, container) at a time, a few in parallel,
//     and gives no progress of its own;
//   • remediation: for each image, which vulnerabilities have a fix and what to
//     upgrade (package → version), grouped so the biggest wins come first;
//   • scan failure reasons from the operator's log, with a hint for the
//     common causes (private registry access, memory, timeouts, quotas).

// ---------------------------------------------------------------- coverage --

const L_KIND = 'trivy-operator.resource.kind';
const L_NAME = 'trivy-operator.resource.name';
const L_NS = 'trivy-operator.resource.namespace';
const L_CONTAINER = 'trivy-operator.container.name';

const ownerOf = (pod) => {
  const refs = pod.metadata?.ownerReferences || [];
  const ref = refs.find((r) => r.controller) || refs[0];
  return ref ? { kind: ref.kind, name: ref.name } : { kind: 'Pod', name: pod.metadata?.name };
};

/**
 * What the operator scans: one unit per (workload, container) of the running
 * pods — replicas share a unit. { namespace, kind, name, container, image, imageID }.
 */
export function scanUnits(pods) {
  const units = new Map();
  for (const pod of pods || []) {
    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const namespace = pod.metadata?.namespace || '';
    const owner = ownerOf(pod);
    const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];
    for (const c of [...(pod.spec?.initContainers || []), ...(pod.spec?.containers || [])]) {
      const key = `${namespace}|${owner.kind}|${owner.name}|${c.name}`;
      if (units.has(key)) continue;
      units.set(key, {
        key, namespace, kind: owner.kind, name: owner.name, container: c.name, image: c.image || '',
        imageID: statuses.find((s) => s.name === c.name)?.imageID || '',
      });
    }
  }
  return [...units.values()];
}

/** The workload a report (or scan job) belongs to, from the operator's labels. */
export function reportTarget(obj) {
  const l = obj?.metadata?.labels || {};
  return {
    namespace: l[L_NS] || obj?.metadata?.namespace || '',
    kind: l[L_KIND] || '',
    name: l[L_NAME] || '',
    container: l[L_CONTAINER] || '',
    digest: obj?.report?.artifact?.digest || '',
  };
}

// Jobs created by a CronJob are named <cronjob>-<schedule time>; the operator
// scans the CronJob itself.
const cronJobOf = (jobName) => (/^(.+)-\d{6,}$/.exec(jobName || '') || [])[1] || null;

const sameWorkload = (unit, t) => {
  if (t.namespace !== unit.namespace) return false;
  if (t.kind === unit.kind && t.name === unit.name) return true;
  return unit.kind === 'Job' && t.kind === 'CronJob' && cronJobOf(unit.name) === t.name;
};

/**
 * Coverage of the running images by vulnerability reports. Images are the
 * distinct image references of the units; an image is scanned when any unit
 * using it has a report (same workload + container, or the same digest).
 * Not-scanned images are 'Scanning' when an active scan job targets one of
 * their workloads, 'Failed' when a failed one does, else 'Not Scanned'.
 *
 * jobs: [{ target: reportTarget(job), active: bool, failed: bool }]
 * → { images, scanned, notScanned, pending: [{ image, namespace, status, workloads }] }
 */
export function scanCoverage(units, reports, jobs = []) {
  const targets = (reports || []).map(reportTarget);
  const digests = new Set(targets.map((t) => t.digest).filter(Boolean));
  const covered = (u) => targets.some((t) => sameWorkload(u, t) && (!t.container || t.container === u.container))
    || (u.imageID && [...digests].some((d) => u.imageID.endsWith(d)));
  const byImage = new Map();
  for (const u of units) {
    if (!byImage.has(u.image)) byImage.set(u.image, { image: u.image, units: [], scanned: false });
    const g = byImage.get(u.image);
    g.units.push(u);
    if (covered(u)) g.scanned = true;
  }
  const jobFor = (u, pred) => jobs.some((j) => pred(j) && sameWorkload(u, j.target) && (!j.target.container || j.target.container === u.container));
  const pending = [];
  let scanned = 0;
  for (const g of byImage.values()) {
    if (g.scanned) { scanned += 1; continue; }
    const status = g.units.some((u) => jobFor(u, (j) => j.active)) ? 'Scanning'
      : g.units.some((u) => jobFor(u, (j) => j.failed)) ? 'Failed' : 'Not Scanned';
    pending.push({
      image: g.image,
      namespace: g.units[0].namespace,
      status,
      workloads: g.units.map((u) => ({ kind: u.kind, name: u.name, namespace: u.namespace, container: u.container })),
    });
  }
  return { images: byImage.size, scanned, notScanned: pending.length, pending };
}

// --------------------------------------------- running images & revisions --

/**
 * A predicate: does this report belong to something running now? Reports
 * outlive their pods — a Deployment keeps its old ReplicaSets (scaled to 0)
 * for rollback and the operator keeps their reports — so an image a developer
 * already replaced would otherwise still be counted.
 */
export function runningReportCheck(units) {
  const digests = units.map((u) => u.imageID).filter(Boolean);
  return (report) => {
    const t = reportTarget(report);
    return units.some((u) => sameWorkload(u, t) && (!t.container || t.container === u.container))
      || (!!t.digest && digests.some((id) => id.endsWith(t.digest)));
  };
}

const findingKey = (v) => `${v.id || v.vulnerabilityID}|${v.pkg ?? v.resource ?? ''}`;
const uniqueFindings = (list) => {
  const seen = new Set();
  return list.filter((v) => { const k = findingKey(v); return seen.has(k) ? false : (seen.add(k), true); });
};

/**
 * What the latest image of each Deployment changed, per container: the
 * vulnerabilities of the previous image (the newest older revision that ran a
 * different image — a config-only rollout keeps the image) that the current
 * one no longer has (resolved) and the ones it added (introduced). Only the
 * newest revision of each Deployment + container gets an entry.
 *
 * reports: VulnerabilityReports; replicaSets: [{ namespace, name, deployment, revision }]
 * vulnsOf(report) → [{ id, severity, pkg, installedVersion, fixedVersion }]
 * imageOf(report) → image reference
 * → Map(report → { workload, container, previousImage, previousRevision, revision, resolved, introduced })
 */
export function revisionChanges(reports, replicaSets, { vulnsOf, imageOf }) {
  const imageKey = (r) => `${imageOf(r)}@${r?.report?.artifact?.digest || ''}`;
  const rsByKey = new Map((replicaSets || []).map((rs) => [`${rs.namespace}|${rs.name}`, rs]));
  const lines = new Map(); // ns|deployment|container -> [{ revision, report }]
  for (const r of reports || []) {
    const t = reportTarget(r);
    if (t.kind !== 'ReplicaSet') continue;
    const rs = rsByKey.get(`${t.namespace}|${t.name}`);
    if (!rs?.deployment || !Number.isFinite(rs.revision)) continue;
    const key = `${t.namespace}|${rs.deployment}|${t.container}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ revision: rs.revision, report: r, deployment: rs.deployment, container: t.container });
  }
  const out = new Map();
  for (const line of lines.values()) {
    line.sort((a, b) => b.revision - a.revision);
    const [cur] = line;
    const prev = line.find((x) => x.revision < cur.revision && imageKey(x.report) !== imageKey(cur.report));
    if (!prev) continue;
    const now = vulnsOf(cur.report);
    const before = vulnsOf(prev.report);
    const nowKeys = new Set(now.map(findingKey));
    const beforeKeys = new Set(before.map(findingKey));
    out.set(cur.report, {
      workload: `Deployment ${cur.deployment}`,
      container: cur.container,
      revision: cur.revision,
      previousRevision: prev.revision,
      previousImage: imageOf(prev.report),
      resolved: uniqueFindings(before.filter((v) => !nowKeys.has(findingKey(v)))),
      introduced: uniqueFindings(now.filter((v) => !beforeKeys.has(findingKey(v)))),
    });
  }
  return out;
}

/** Severity counts of a (deduplicated) vulnerability list. */
export function severityCounts(vulns) {
  const out = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const v of vulns || []) out[v.severity in out ? v.severity : 'UNKNOWN'] += 1;
  return out;
}

// ------------------------------------------------------------- remediation --

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const rank = (s) => { const i = SEV_ORDER.indexOf(s); return i < 0 ? SEV_ORDER.length : i; };

/** Compare version strings loosely: numeric parts numerically, the rest as text. */
export function compareLooseVersions(a, b) {
  const pa = String(a || '').split(/[^0-9A-Za-z]+/).filter(Boolean);
  const pb = String(b || '').split(/[^0-9A-Za-z]+/).filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; continue; }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const major = (v) => String(v || '').replace(/^v/i, '').split(/[^0-9]/)[0];

/**
 * The version to upgrade to for one vulnerability. Trivy lists alternatives
 * ("1.2.4, 1.3.2" — fixed in either line); prefer the one on the installed
 * version's major line, else the lowest.
 */
export function pickFixedVersion(fixedVersion, installedVersion) {
  const options = String(fixedVersion || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!options.length) return '';
  const sameLine = options.filter((o) => major(o) && major(o) === major(installedVersion));
  return [...(sameLine.length ? sameLine : options)].sort(compareLooseVersions)[0];
}

/**
 * What to do about an image's vulnerabilities:
 * { total, fixable, noFix, fixableBySeverity, osFixes, appFixes, upgrades: [
 *     { pkg, installedVersion, upgradeTo, class, packageType, packagePath, target, cves, worst, bySeverity } ] }
 * One upgrade per installed package; its target is the highest version any of
 * its fixable vulnerabilities needs. Sorted by worst severity, then by how
 * many vulnerabilities the upgrade fixes.
 */
export function remediationFor(vulns) {
  const out = {
    total: 0, fixable: 0, noFix: 0, osFixes: 0, appFixes: 0,
    fixableBySeverity: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
    upgrades: [],
  };
  const groups = new Map();
  for (const v of vulns || []) {
    out.total += 1;
    const to = pickFixedVersion(v.fixedVersion, v.installedVersion);
    if (!to) { out.noFix += 1; continue; }
    out.fixable += 1;
    out.fixableBySeverity[v.severity] = (out.fixableBySeverity[v.severity] || 0) + 1;
    if (v.class === 'os-pkgs') out.osFixes += 1; else if (v.class) out.appFixes += 1;
    const key = `${v.pkg}|${v.installedVersion}|${v.packagePath || v.target || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        pkg: v.pkg, installedVersion: v.installedVersion, upgradeTo: to,
        class: v.class || '', packageType: v.packageType || '', packagePath: v.packagePath || '', target: v.target || '',
        cves: 0, worst: v.severity, bySeverity: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      });
    }
    const g = groups.get(key);
    g.cves += 1;
    g.bySeverity[v.severity] = (g.bySeverity[v.severity] || 0) + 1;
    if (rank(v.severity) < rank(g.worst)) g.worst = v.severity;
    if (compareLooseVersions(to, g.upgradeTo) > 0) g.upgradeTo = to;
  }
  out.upgrades = [...groups.values()].sort((a, b) => rank(a.worst) - rank(b.worst) || b.cves - a.cves || a.pkg.localeCompare(b.pkg));
  return out;
}

// --------------------------------------------------------- scan failures --

const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/g;

/**
 * The part of a failed scan's output that says why. A scan job's status
 * message is the tail of the scanner's log — INFO/WARN progress lines, with
 * the FATAL/ERROR line that matters at the end — so keep the last FATAL or
 * ERROR entry (timestamps dropped), else the last entry.
 */
export function scannerFailure(output) {
  const entries = String(output || '')
    .split(/(?=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s)/)
    .map((e) => e.replace(TIMESTAMP, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const failure = [...entries].reverse().find((e) => /^(FATAL|ERROR)\b/.test(e));
  return failure || entries.at(-1) || '';
}

// Operator errors that are routine and retried, not scan failures: a report
// or object already gone when it tries to clean it up (e.g. the old
// ReplicaSet of a rollout), or an optimistic-concurrency conflict.
const BENIGN = [
  /failed marking old reports for immediate deletion.*not found/i,
  /\bnot found\b.*\b(delet|clean)/i,
  /the object has been modified; please apply your changes/i,
];

/**
 * Error messages from the operator's (JSON-lines) log, newest last, deduped:
 * scan job failures carry the scanner's own error in their fields, of which
 * the FATAL/ERROR line is kept. Routine retried errors are left out.
 */
export function operatorLogErrors(text, { max = 6 } = {}) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"error"') && !/\blevel=error\b/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { entry = null; }
    if (entry && entry.level !== 'error') continue;
    const scanner = entry && typeof entry['status.message'] === 'string' ? scannerFailure(entry['status.message']) : '';
    const parts = entry
      ? [entry.msg, scanner, entry.error].filter((s) => typeof s === 'string' && s.trim())
      : [line];
    const message = parts.join(' — ').replace(TIMESTAMP, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!message || BENIGN.some((re) => re.test(message))) continue;
    const key = message.replace(/scan-vulnerabilityreport-[a-z0-9]+/gi, 'scan-job').replace(/\b[0-9a-f]{8,}\b/gi, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out.slice(-max);
}

const HINTS = [
  [/unauthori[sz]ed|authentication required|no basic auth credentials|access denied|denied: |\b40[13] (unauthorized|forbidden)/i, 'registry',
    'Scan jobs could not pull private images. Give the Trivy Operator read access to your registry — for Amazon ECR, an IAM role with the AmazonEC2ContainerRegistryReadOnly policy bound to the trivy-operator service account (IRSA or EKS Pod Identity); otherwise image pull secrets.'],
  [/no space left on device|ephemeral[- ]storage|disk quota/i, 'disk',
    'Scan jobs ran out of disk space unpacking large images. Raise the scan job storage limit (Helm value trivy.resources.limits.ephemeral-storage), or switch the operator to Trivy client/server mode.'],
  [/manifest unknown|image not found|not found: manifest|name unknown/i, 'image-missing',
    'The scanned image tag no longer exists in its registry (deleted or retagged). Redeploy the workload with an existing image, or remove the stale workload.'],
  [/OOMKilled|out of memory|memory limit/i, 'memory',
    'Scan jobs ran out of memory. Raise the scan job memory limit (Helm value trivy.resources.limits.memory).'],
  [/deadline|timed? ?out|timeout/i, 'timeout',
    'Scan jobs timed out. Raise the scan job timeout (Helm value operator.scanJobTimeout), or lower parallel scans if nodes are busy.'],
  [/exceeded quota|quota exceeded|FailedCreate|insufficient (cpu|memory)|Unschedulable|untolerated taint/i, 'capacity',
    'Scan job pods could not be created or scheduled (resource quota or node capacity in the operator namespace).'],
  [/trivy-db|vulnerability (db|database)|(download|update)\w* (the )?(vulnerability )?db\b|ghcr\.io\/aquasecurity\/trivy-(java-)?db/i, 'database',
    'Scan jobs could not download the Trivy vulnerability database. Allow egress to ghcr.io (or configure a DB mirror in the operator settings).'],
];

/** One hint per recognised cause: [{ id, text }]. */
export function failureHints(messages) {
  const text = (messages || []).join('\n');
  return HINTS.filter(([re]) => re.test(text)).map(([, id, hint]) => ({ id, text: hint }));
}
