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

/**
 * Error messages from the operator's (JSON-lines) log, newest last, deduped:
 * scan job failures carry the scanner's own error in their fields.
 */
export function operatorLogErrors(text, { max = 6 } = {}) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"error"') && !/\blevel=error\b/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { entry = null; }
    if (entry && entry.level !== 'error') continue;
    const parts = entry
      ? [entry.msg, entry['status.message'], entry.error].filter((s) => typeof s === 'string' && s.trim())
      : [line];
    const message = parts.join(' — ').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!message) continue;
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
