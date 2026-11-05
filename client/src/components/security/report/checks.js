// The resource checks report: the failed Trivy Operator checks of one
// Kubernetes resource — configuration audit (Deployments, StatefulSets, …,
// the Resources tab) or RBAC assessment (Roles and ClusterRoles, the Roles
// tab). Built from what the drawer already has (/api/security/checks).
//
// The cluster name is masked like everywhere in the UI, and so are the
// findings' messages (they quote the resource's manifest); the checks'
// descriptions are public best-practice text.
import { mask } from './model';
import {
  SEVERITIES, SEV_RANK, closingNote, emptyCounts, esc, formatWhen, join, localDate, num, pill, plural, props,
  renderDocument, sevBreakdown, sevOf, severityTable, slug,
} from './shared';

const RBAC_KINDS = new Set(['Role', 'ClusterRole']);
const MAX_CARDS = 250;

/** 'rbac' for the Roles tab's findings, else 'config'. */
export const checksKindOf = (resource, which) => (which === 'rbac' || which === 'config' ? which : (RBAC_KINDS.has(resource?.kind) ? 'rbac' : 'config'));

/**
 * resource  the drawer's resource: { kind, name, namespace, createdAt, scannedAt, scanner, labels, checks[] }
 * options   { which: 'config' | 'rbac', context, generatedAt }
 */
export function buildChecksModel(resource, { which, context = '', generatedAt = new Date() } = {}) {
  const r = resource || {};
  const type = checksKindOf(r, which);
  const seen = new Set();
  const checks = [];
  for (const c of r.checks || []) {
    const description = typeof c.description === 'string' ? c.description : '';
    // The server sends every message; older data only the first (or the description).
    const raw = Array.isArray(c.messages) && c.messages.length ? c.messages : (c.message && c.message !== description ? [c.message] : []);
    const messages = raw.filter((x) => typeof x === 'string' && x).map(mask);
    const key = `${c.id}|${c.title}|${messages.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push({
      id: String(c.id || ''),
      title: c.title || '',
      severity: sevOf(c.severity),
      category: c.category || '',
      description,
      messages,
      remediation: c.remediation || '',
    });
  }
  checks.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.id.localeCompare(b.id));

  const counts = emptyCounts();
  for (const c of checks) counts[c.severity] += 1;
  const categories = [...checks.reduce((m, c) => m.set(c.category || 'Other', (m.get(c.category || 'Other') || 0) + 1), new Map())]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const label = `${r.kind || 'Resource'} ${r.name || ''}`.trim();
  return {
    type,
    title: `${type === 'rbac' ? 'RBAC assessment' : 'Configuration audit'} report: ${label}`,
    generatedAt: generatedAt instanceof Date ? generatedAt : new Date(generatedAt),
    resource: {
      kind: r.kind || '',
      name: r.name || '',
      namespace: r.namespace || '',
      context: mask(context),
      createdAt: r.createdAt || '',
      scannedAt: r.scannedAt || '',
      scanner: r.scanner || '',
      labels: r.labels || 0,
    },
    checks,
    keyChecks: checks.filter((c) => c.severity === 'CRITICAL' || c.severity === 'HIGH'),
    counts,
    total: checks.length,
    risk: SEVERITIES.find((s) => counts[s] > 0) || null,
    categories,
  };
}

/** "config-audit-report_shop_deployment-payments_2026-11-05.pdf" */
export function checksFileName(model, ext) {
  const r = model.resource;
  const parts = [
    model.type === 'rbac' ? 'rbac-assessment-report' : 'config-audit-report',
    slug(r.namespace),
    slug(`${r.kind}-${r.name}`.toLowerCase()) || 'resource',
  ].filter(Boolean);
  return `${parts.join('_')}_${localDate(model.generatedAt)}.${ext}`;
}

// ---------------------------------------------------------------- HTML --

const what = (m) => `${esc(m.resource.kind)} <strong>${esc(m.resource.name)}</strong>${m.resource.namespace ? ` in namespace <strong>${esc(m.resource.namespace)}</strong>` : ''}`;
const msgList = (msgs) => (msgs.length ? `<ul class="msgs">${msgs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');

function executiveSummary(m) {
  if (!m.total) return `<p>${what(m)} passes every check that was run.</p>`;
  const parts = [`${what(m)} fails <strong>${plural(m.total, 'security check')}</strong>: ${esc(join(sevBreakdown(m.counts)))}.`];
  if (m.keyChecks.length) parts.push(`${plural(m.keyChecks.length, 'is', 'are')} critical or high and should be fixed first.`);
  if (m.categories.length > 1) parts.push(`By category: ${esc(join(m.categories.map((c) => `${num(c.count)} ${c.name}`)))}.`);
  let html = `<p>${parts.join(' ')}</p>`;
  const top = m.keyChecks.slice(0, 5);
  if (top.length) {
    html += `<div class="callout"><div class="callout-title">Fix first</div><ul>${top.map((c) => `<li>${pill(c.severity)} <strong>${esc(c.title || c.id)}</strong> <code>${esc(c.id)}</code>${c.remediation ? `<div class="callout-sub">${esc(c.remediation)}</div>` : ''}</li>`).join('')}</ul></div>`;
  }
  return html;
}

function resourceDetails(m) {
  const r = m.resource;
  return `${props([
    ['Kind', esc(r.kind)],
    ['Name', `<strong>${esc(r.name)}</strong>`],
    ['Namespace', r.namespace ? esc(r.namespace) : '<span class="dim">Cluster-wide</span>'],
    r.context && ['Cluster', esc(r.context)],
    r.createdAt && ['Created', esc(formatWhen(r.createdAt))],
    r.scannedAt && ['Checked', esc(formatWhen(r.scannedAt))],
    r.scanner && ['Scanner', esc(r.scanner)],
    r.labels ? ['Labels', esc(`${r.labels} label${r.labels === 1 ? '' : 's'}`)] : null,
  ])}
  <p class="fineprint">Account IDs, IP addresses and internal host names are masked in this report.</p>`;
}

function actions(m) {
  if (!m.total) return '<p>No action needed.</p>';
  // One row per check, however many containers or rules it failed for.
  const byId = new Map();
  for (const c of m.checks) {
    const g = byId.get(c.id) || { ...c, findings: 0 };
    g.findings += Math.max(1, c.messages.length);
    byId.set(c.id, g);
  }
  return `<p class="lead-in">What to change in the ${m.type === 'rbac' ? 'role' : 'manifest'}, worst first.</p>
  <table class="grid">
    <thead><tr><th>Severity</th><th>Check</th><th>What to change</th></tr></thead>
    <tbody>${[...byId.values()].map((c) => `<tr>
      <td>${pill(c.severity)}</td>
      <td><strong>${esc(c.title || c.id)}</strong><div class="sub">${esc(c.id)}${c.findings > 1 ? ` · ${c.findings} findings` : ''}</div></td>
      <td>${c.remediation ? esc(c.remediation) : '<span class="dim">See the check\'s description.</span>'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function card(c) {
  const meta = [
    c.category && ['Category', esc(c.category)],
    c.messages.length && ['Finding', msgList(c.messages)],
  ].filter(Boolean);
  return `<article class="card card-${c.severity.toLowerCase()}">
    <header><span class="card-id">${esc(c.id)}</span>${pill(c.severity)}</header>
    ${c.title ? `<div class="card-title">${esc(c.title)}</div>` : ''}
    ${meta.length ? `<dl class="card-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${c.description ? `<p class="desc">${esc(c.description)}</p>` : ''}
    ${c.remediation ? `<div class="fix"><strong>How to fix:</strong> ${esc(c.remediation)}</div>` : ''}
  </article>`;
}

function keyDetails(m) {
  if (!m.keyChecks.length) return '<p>No critical or high findings.</p>';
  const shown = m.keyChecks.slice(0, MAX_CARDS);
  const more = m.keyChecks.length > shown.length ? `<p class="note">The other ${m.keyChecks.length - shown.length} critical and high findings are listed in the full table.</p>` : '';
  return `${shown.map(card).join('')}${more}`;
}

function allChecks(m) {
  if (!m.total) return '<p>No failed checks.</p>';
  return `<table class="grid checks">
    <thead><tr><th class="num">#</th><th>Check</th><th>Severity</th><th>Category</th><th>Finding</th></tr></thead>
    <tbody>${m.checks.map((c, i) => `<tr>
      <td class="num dim">${i + 1}</td>
      <td><strong>${esc(c.title || c.id)}</strong><div class="sub">${esc(c.id)}</div></td>
      <td>${pill(c.severity)}</td>
      <td>${esc(c.category)}</td>
      <td>${c.messages.length ? msgList(c.messages) : `<span class="dim">${esc(c.description)}</span>`}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function appendix(m) {
  const rbac = m.type === 'rbac';
  return `<h3>Severity ratings</h3>
  ${severityTable(['Severity', 'Meaning'], [
    ['CRITICAL', rbac ? 'Grants access that amounts to control of the cluster or its secrets. Fix immediately.' : 'A weakness that can lead directly to compromise of the node or cluster (for example a privileged container). Fix immediately.'],
    ['HIGH', rbac ? 'Grants broad or sensitive access beyond what most workloads need. Fix as a priority.' : 'A significant weakness in isolation or privileges (for example running as root). Fix as a priority.'],
    ['MEDIUM', 'Weakens defence in depth. Fix in the normal release cycle.'],
    ['LOW', 'A best-practice deviation with minor risk. Fix when convenient.'],
    ['UNKNOWN', 'Not rated by the check.'],
  ])}
  <h3>About this report</h3>
  <p>The checks come from the Trivy Operator running in the cluster (its ${rbac ? 'RbacAssessmentReport' : 'ConfigAuditReport'} resources)${m.resource.scannedAt ? `, as of ${esc(formatWhen(m.resource.scannedAt))}` : ''}. ${rbac
    ? 'Each check looks for risky permissions in the role, such as access to secrets, wildcard verbs or resources, or the right to create pods or bind roles.'
    : 'Each check compares the resource\'s manifest with a Kubernetes security best practice, such as running as a non-root user, a read-only root file system, or resource limits.'} Only the checks that failed are listed.</p>
  <p>This is a point-in-time snapshot: the operator checks a resource again when it changes. Check again after fixing, and when new checks are released.</p>
  ${closingNote(m.generatedAt)}`;
}

export function checksHtml(model) {
  const m = model;
  const rbac = m.type === 'rbac';
  const sections = [
    ['summary', 'Executive summary', executiveSummary],
    ['resource', rbac ? 'Role details' : 'Resource details', resourceDetails],
    ['actions', 'Recommended actions', actions],
    ['key', 'Critical and high findings', keyDetails],
    ['all', `All failed checks (${num(m.total)})`, allChecks],
  ].map(([key, title, render]) => ({ key, title, body: render(m) }));
  return renderDocument({
    title: m.title,
    docType: rbac ? 'RBAC assessment report' : 'Configuration audit report',
    eyebrow: rbac ? 'Kubernetes RBAC security assessment' : 'Kubernetes resource security assessment',
    heading: `${m.resource.kind} ${m.resource.name}`.trim(),
    subheading: [m.resource.namespace ? `namespace ${m.resource.namespace}` : 'cluster-wide', m.resource.context].filter(Boolean).join(' · '),
    risk: m.risk,
    noRisk: 'No failed checks',
    counts: m.counts,
    stats: [
      [num(m.total), `failed check${m.total === 1 ? '' : 's'}`],
      [num(m.keyChecks.length), 'critical or high'],
      [num(m.categories.length), `categor${m.categories.length === 1 ? 'y' : 'ies'}`],
    ],
    sections,
    appendix: appendix(m),
    generatedAt: m.generatedAt,
  });
}
