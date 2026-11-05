// The downloadable vulnerability report's content, built from what the image
// drawer already has (every finding, the remediation summary, the workloads)
// plus the advisory details the server returns on demand
// (GET /api/security/vulnerabilities/details: descriptions, dates, CVSS
// vectors, references).
//
// Environment identifiers are masked exactly as in the UI (AWS account ids in
// ECR hosts, IPs, internal hosts, ARNs in context names): the report is meant
// to be shared outside the team that runs the cluster. Advisory text and links
// are public and kept as they are.
import { redactSensitive } from '../../../lib/redact';
import { splitImage } from '../ImageName';
import { SEVERITIES, SEV_RANK as RANK, emptyCounts, localDate, sevOf, slug } from './shared';

export const mask = (s) => (s ? redactSensitive(String(s)) : '');
const keyOf = (id, pkg, ver) => `${id || ''}|${pkg || ''}|${ver || ''}`;

/** http(s) URLs only (no javascript:, data:, file: …); '' otherwise. */
export function safeLink(u) {
  const s = typeof u === 'string' ? u.trim() : '';
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

/** Trivy's package classes, in words. */
export function packageKind(x = {}) {
  if (x.class === 'os-pkgs') return 'OS package';
  if (x.class === 'lang-pkgs') return 'Application dependency';
  return '';
}

// Where the package is: its path (a jar, a Go binary, a lockfile) for
// application dependencies. An OS package's "target" is the image itself.
const locationOf = (x = {}) => mask(x.packagePath || (x.class === 'lang-pkgs' ? x.target : '') || '');

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * image   the drawer's image object (from /api/security/vulnerabilities or the built-in scan)
 * options { context, details, generatedAt }
 *   details: the /details response — { source, available, details[], remediation }
 */
export function buildReportModel(image, { context = '', details = null, generatedAt = new Date() } = {}) {
  const d = image || {};
  const adv = new Map((details?.details || []).map((x) => [keyOf(x.id, x.pkg, x.installedVersion), x]));

  const seen = new Set();
  const findings = [];
  for (const v of d.vulnerabilities || []) {
    const k = keyOf(v.id, v.pkg, v.installedVersion);
    if (!v.id || seen.has(k)) continue;
    seen.add(k);
    const x = adv.get(k) || {};
    const links = [...new Set([safeLink(v.link), ...(x.links || []).map(safeLink)].filter(Boolean))];
    findings.push({
      id: String(v.id),
      severity: sevOf(v.severity),
      score: finite(v.score) ?? finite(x.cvssScore),
      pkg: v.pkg || '',
      installedVersion: v.installedVersion || '',
      fixedVersion: v.fixedVersion || '',
      kind: packageKind(v),
      packageType: v.packageType || '',
      location: locationOf(v),
      title: v.title || '',
      description: x.description || '',
      publishedDate: x.publishedDate || '',
      lastModifiedDate: x.lastModifiedDate || '',
      cvssVector: x.cvssVector || '',
      cvssSource: x.cvssSource || '',
      link: links[0] || '',
      links,
    });
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]
    || (b.score ?? -1) - (a.score ?? -1)
    || a.id.localeCompare(b.id)
    || a.pkg.localeCompare(b.pkg));

  // Counted from the list the report shows, so the totals and the tables agree.
  const counts = emptyCounts();
  for (const f of findings) counts[f.severity] += 1;
  const total = findings.length;
  const fixable = findings.filter((f) => f.fixedVersion).length;
  const isKey = (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH';
  const keyFindings = findings.filter(isKey);

  const remediation = d.remediation || details?.remediation || null;
  const upgrades = (remediation?.upgrades || []).map((u) => ({
    pkg: u.pkg || '',
    installedVersion: u.installedVersion || '',
    upgradeTo: u.upgradeTo || '',
    cves: u.cves || 0,
    worst: sevOf(u.worst),
    bySeverity: { ...emptyCounts(), ...(u.bySeverity || {}) },
    kind: packageKind(u),
    packageType: u.packageType || '',
    location: locationOf(u),
  }));

  const { name, location } = splitImage(d.image);
  const repository = mask(d.repository) || name.split(':')[0];
  return {
    title: `Vulnerability report: ${name || 'image'}`,
    generatedAt: generatedAt instanceof Date ? generatedAt : new Date(generatedAt),
    source: details?.source || (/built-in/i.test(d.scanner || '') ? 'builtin' : 'operator'),
    image: {
      ref: mask(d.image),
      name,
      location,
      repository,
      tag: d.tag || '',
      digest: d.digest || '',
      os: d.os || '',
      platform: d.platform && d.platform !== d.os ? d.platform : '',
      namespace: d.namespace || '',
      scanner: d.scanner || '',
      scannedAt: d.scannedAt || '',
      running: d.active !== false,
      context: mask(context),
    },
    workloads: (d.workloads || []).map((w) => ({
      kind: w.kind || '', name: w.name || '', namespace: w.namespace || '', container: w.container || '', running: w.running !== false,
    })),
    counts,
    total,
    risk: SEVERITIES.find((s) => counts[s] > 0) || null,
    fix: {
      fixable,
      noFix: total - fixable,
      keyTotal: keyFindings.length,
      keyFixable: keyFindings.filter((f) => f.fixedVersion).length,
      osFindings: findings.filter((f) => f.kind === 'OS package').length,
      appFindings: findings.filter((f) => f.kind === 'Application dependency').length,
    },
    upgrades,
    findings,
    keyFindings,
    secrets: (d.secretsList || []).map((s) => ({
      ruleID: s.ruleID || '', title: s.title || '', severity: sevOf(s.severity),
      location: mask(`${s.target || ''}${s.line ? `:${s.line}` : ''}`),
    })),
    secretsCount: d.secrets || (d.secretsList || []).length || 0,
    changes: (d.changes || []).map((c) => ({
      workload: c.workload || '',
      container: c.container || '',
      revision: c.revision,
      previousRevision: c.previousRevision,
      previousImage: splitImage(c.previousImage).name,
      resolved: (c.resolved || []).map((v) => ({ id: v.id, severity: sevOf(v.severity), pkg: v.pkg || '' })),
      introduced: (c.introduced || []).map((v) => ({ id: v.id, severity: sevOf(v.severity), pkg: v.pkg || '' })),
    })),
    detailsAvailable: !!details?.available && (details?.details || []).length > 0,
  };
}

/**
 * "vulnerability-report_bo-backend_release-359_2026-11-05.pdf" — the image's
 * own name and tag only (never the registry host or account).
 */
export function reportFileName(model, ext) {
  const repo = slug((model.image.repository || model.image.name || '').split('/').pop().split(':')[0]) || 'image';
  const tag = slug(model.image.tag || (model.image.digest || '').replace(/^sha256:/, '').slice(0, 12));
  return `${['vulnerability-report', repo, tag].filter(Boolean).join('_')}_${localDate(model.generatedAt)}.${ext}`;
}
