// The image vulnerability report (an HTML document; see shared.js for the page).
import {
  breakable, closingNote, esc, formatDay, formatWhen, join, link, num, pct, pill, plural, props,
  renderDocument, sevBreakdown, severityTable,
} from './shared';

export { formatWhen } from './shared';

const score = (n) => (n == null ? '' : Number(n).toFixed(1));
const kindText = (x) => [x.kind, x.packageType].filter(Boolean).join(' · ');

const MAX_CARDS = 250; // detail cards; every finding is still in the full table
const MAX_WORKLOADS = 50;

function executiveSummary(m) {
  const { total, counts, fix, upgrades } = m;
  if (!total) {
    return '<p>No known vulnerabilities were found in this image when it was scanned.</p>';
  }
  const parts = [
    `This image has <strong>${plural(total, 'known vulnerability', 'known vulnerabilities')}</strong>: ${esc(join(sevBreakdown(counts)))}.`,
    `<strong>${num(fix.fixable)} of them (${pct(fix.fixable, total)}%)</strong> have a fixed version available`
      + (fix.keyTotal ? `, including <strong>${fix.keyFixable} of ${fix.keyTotal}</strong> critical and high.` : '.'),
  ];
  if (upgrades.length) parts.push(`Upgrading ${plural(upgrades.length, 'package')} resolves every finding that has a fix.`);
  const where = [
    fix.osFindings && `${num(fix.osFindings)} in operating-system packages from the base image`,
    fix.appFindings && `${num(fix.appFindings)} in application dependencies`,
  ].filter(Boolean);
  if (where.length) parts.push(`By location: ${join(where)}.`);
  let html = `<p>${parts.join(' ')}</p>`;
  if (m.secretsCount) html += `<p>The scan also found <strong>${plural(m.secretsCount, 'exposed secret')}</strong> in the image (see section ${m.sectionOf.secrets}).</p>`;
  if (!m.image.running) html += '<p class="note">No pod runs this image any more: a newer revision replaced it. Its report is kept while the old ReplicaSet is kept for rollback.</p>';
  const top = m.keyFindings.slice(0, 5);
  if (top.length) {
    html += `<div class="callout"><div class="callout-title">Fix first</div><ul>${top.map((f) => `<li>${pill(f.severity)} <strong>${link(f.link, f.id)}</strong> in <code>${esc(f.pkg)}</code> ${esc(f.installedVersion)}${f.score != null ? ` · CVSS ${score(f.score)}` : ''}${f.fixedVersion ? ` → fixed in <code>${esc(f.fixedVersion)}</code>` : ' · no fix yet'}${f.title ? `<div class="callout-sub">${esc(f.title)}</div>` : ''}</li>`).join('')}</ul></div>`;
  }
  return html;
}

function imageDetails(m) {
  const i = m.image;
  const wl = m.workloads.slice(0, MAX_WORKLOADS).map((w) => `<li>${esc(w.kind)} <strong>${esc(w.name)}</strong> <span class="dim">· namespace ${esc(w.namespace)}${w.container ? ` · container ${esc(w.container)}` : ''}${w.running ? '' : ' · not running'}</span></li>`).join('');
  const more = m.workloads.length > MAX_WORKLOADS ? `<li class="dim">and ${m.workloads.length - MAX_WORKLOADS} more</li>` : '';
  return `${props([
    ['Image', `<code class="wrap">${esc(i.ref)}</code>`],
    i.tag && ['Tag', esc(i.tag)],
    i.digest && ['Digest', `<code class="wrap">${esc(i.digest)}</code>`],
    i.os && ['Operating system', esc(i.os)],
    i.platform && ['Platform', esc(i.platform)],
    i.context && ['Cluster', esc(i.context)],
    i.namespace && ['Namespace', esc(i.namespace)],
    ['Status', i.running ? 'Running' : 'Not running (replaced by a newer revision)'],
    i.scannedAt && ['Scanned', esc(formatWhen(i.scannedAt))],
    i.scanner && ['Scanner', esc(i.scanner)],
    wl && [m.workloads.length === 1 ? 'Used by' : `Used by (${m.workloads.length})`, `<ul class="plain">${wl}${more}</ul>`],
  ])}
  <p class="fineprint">Account IDs, IP addresses and internal host names are masked in this report. The digest identifies the exact image.</p>`;
}

function actions(m) {
  const { fix, upgrades } = m;
  const repo = (m.image.repository || m.image.name || '').split('/').pop().split(':')[0];
  const tips = [];
  if (m.total && m.image.tag) {
    tips.push(`<li><strong>Use a newer image.</strong> Check for a newer release of <code>${esc(repo)}</code> (this one is <code>${esc(m.image.tag)}</code>). Maintainers rebuild images with fixed packages, so moving the workload to a newer image is often the quickest fix.</li>`);
  }
  if (fix.osFindings) {
    tips.push(`<li><strong>Rebuild on a patched base image.</strong> ${plural(fix.osFindings, 'finding is', 'findings are')} in operating-system packages${m.image.os ? ` (${esc(m.image.os)})` : ''}: rebuild on the latest patch of the base image, or upgrade the packages below in the Dockerfile.</li>`);
  }
  if (fix.appFindings) {
    tips.push(`<li><strong>Upgrade application dependencies.</strong> ${plural(fix.appFindings, 'finding is', 'findings are')} in libraries the application ships: bump the versions below, rebuild and redeploy.</li>`);
  }
  if (fix.noFix) {
    tips.push(`<li><strong>No fix yet for ${plural(fix.noFix, 'finding')}.</strong> No fixed version has been published. Check the linked advisories for mitigations, or consider a different base image or package.</li>`);
  }
  if (m.secretsCount) {
    tips.push('<li><strong>Remove and rotate exposed secrets.</strong> Take the secret out of the image, rotate the credential, and pass it to the workload at run time (for example a Kubernetes Secret).</li>');
  }
  let html = tips.length ? `<ol class="tips">${tips.join('')}</ol>` : '<p>No action needed.</p>';
  if (upgrades.length) {
    html += `<h3>Package upgrades</h3>
    <p class="lead-in">One row per installed package: the version that fixes all of its findings, worst first.</p>
    <table class="grid">
      <thead><tr><th>Package</th><th>Type</th><th>Installed</th><th>Upgrade to</th><th class="num">Fixes</th><th>Severity</th></tr></thead>
      <tbody>${upgrades.map((u) => `<tr>
        <td><code>${breakable(u.pkg)}</code>${u.location ? `<div class="sub">${breakable(u.location)}</div>` : ''}</td>
        <td>${esc(kindText(u))}</td>
        <td class="ver"><code>${esc(u.installedVersion)}</code></td>
        <td class="ver"><code class="ok">${esc(u.upgradeTo)}</code></td>
        <td class="num">${u.cves}</td>
        <td>${pill(u.worst)}<div class="sub">${esc(sevBreakdown(u.bySeverity).join(' · '))}</div></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }
  return html;
}

function card(f) {
  const meta = [
    ['Package', `<code>${esc(f.pkg)}</code> <span class="dim">${esc(f.installedVersion)}</span>${f.location ? `<div class="sub">${esc(f.location)}</div>` : ''}`],
    ['Fixed in', f.fixedVersion ? `<code class="ok">${esc(f.fixedVersion)}</code>` : '<span class="dim">No fix published yet</span>'],
    kindText(f) && ['Type', esc(kindText(f))],
    f.score != null && ['CVSS', `<strong>${score(f.score)}</strong>${f.cvssVector ? ` <code class="wrap dim">${esc(f.cvssVector)}</code>` : ''}${f.cvssSource ? ` <span class="dim">(${esc(f.cvssSource)})</span>` : ''}`],
    f.publishedDate && ['Published', esc(formatDay(f.publishedDate)) + (f.lastModifiedDate && f.lastModifiedDate !== f.publishedDate ? ` <span class="dim">· updated ${esc(formatDay(f.lastModifiedDate))}</span>` : '')],
  ].filter(Boolean);
  const refs = f.links.slice(0, 6).map((u) => `<li>${link(u, u)}</li>`).join('');
  return `<article class="card card-${f.severity.toLowerCase()}">
    <header><span class="card-id">${link(f.link, f.id)}</span>${pill(f.severity)}</header>
    ${f.title ? `<div class="card-title">${esc(f.title)}</div>` : ''}
    <dl class="card-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ''}
    ${refs ? `<div class="refs-title">References</div><ul class="refs">${refs}</ul>` : ''}
  </article>`;
}

function keyDetails(m) {
  if (!m.keyFindings.length) return '<p>No critical or high findings.</p>';
  const shown = m.keyFindings.slice(0, MAX_CARDS);
  const note = m.detailsAvailable ? '' : '<p class="note">Advisory descriptions were not available for this scan; each finding links to its advisory.</p>';
  const more = m.keyFindings.length > shown.length ? `<p class="note">The other ${m.keyFindings.length - shown.length} critical and high findings are listed in the full findings table.</p>` : '';
  return `${note}${shown.map(card).join('')}${more}`;
}

function allFindings(m) {
  if (!m.findings.length) return '<p>No vulnerabilities.</p>';
  return `<table class="grid findings">
    <thead><tr><th class="num">#</th><th>Vulnerability</th><th>Severity</th><th class="num">CVSS</th><th>Package</th><th>Installed</th><th>Fixed in</th></tr></thead>
    <tbody>${m.findings.map((f, i) => `<tr>
      <td class="num dim">${i + 1}</td>
      <td><span class="nowrap">${link(f.link, f.id)}</span>${f.title ? `<div class="sub-title">${esc(f.title)}</div>` : ''}</td>
      <td>${pill(f.severity)}</td>
      <td class="num">${score(f.score)}</td>
      <td><code>${breakable(f.pkg)}</code>${kindText(f) ? `<div class="sub">${esc(kindText(f))}</div>` : ''}</td>
      <td class="ver"><code>${esc(f.installedVersion)}</code></td>
      <td class="ver">${f.fixedVersion ? `<code class="ok">${esc(f.fixedVersion)}</code>` : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function secrets(m) {
  if (!m.secrets.length) {
    return `<p>${plural(m.secretsCount, 'exposed secret was', 'exposed secrets were')} reported for this image. The secret scan report lists where.</p>`;
  }
  return `<p class="lead-in">Where each secret was found. The secret values themselves are never included.</p>
  <table class="grid">
    <thead><tr><th>Severity</th><th>Rule</th><th>Location</th></tr></thead>
    <tbody>${m.secrets.map((s) => `<tr><td>${pill(s.severity)}</td><td>${esc(s.title || s.ruleID)}${s.title && s.ruleID ? `<div class="sub">${esc(s.ruleID)}</div>` : ''}</td><td><code class="wrap">${esc(s.location)}</code></td></tr>`).join('')}</tbody>
  </table>`;
}

function changes(m) {
  return m.changes.map((c) => {
    const rows = [
      ...c.resolved.map((v) => ({ v, label: 'Fixed', cls: 'ok' })),
      ...c.introduced.map((v) => ({ v, label: 'New', cls: 'bad' })),
    ];
    const head = `<p><strong>${esc(c.workload)}</strong>${c.container ? ` · ${esc(c.container)}` : ''}: revision ${esc(c.previousRevision)} → ${esc(c.revision)}, previously <code>${esc(c.previousImage)}</code>. ${c.resolved.length} fixed, ${c.introduced.length} new.</p>`;
    if (!rows.length) return `${head}<p class="dim">Same vulnerabilities as the previous image.</p>`;
    return `${head}<table class="grid"><thead><tr><th>Change</th><th>Vulnerability</th><th>Severity</th><th>Package</th></tr></thead><tbody>${rows.map(({ v, label, cls }) => `<tr><td><span class="tag tag-${cls}">${label}</span></td><td>${esc(v.id)}</td><td>${pill(v.severity)}</td><td><code>${esc(v.pkg)}</code></td></tr>`).join('')}</tbody></table>`;
  }).join('');
}

function appendix(m) {
  const source = m.source === 'builtin'
    ? 'a Trivy scan of the image itself'
    : 'the Trivy Operator running in the cluster (its VulnerabilityReport resources)';
  return `<h3>Severity ratings</h3>
  ${severityTable(['Severity', 'CVSS v3 base score', 'Meaning'], [
    ['CRITICAL', '9.0 – 10.0', 'Easy to exploit, often remotely and without credentials, with severe impact. Fix immediately.'],
    ['HIGH', '7.0 – 8.9', 'Serious impact; exploitation may need some conditions. Fix as a priority.'],
    ['MEDIUM', '4.0 – 6.9', 'Limited impact or harder to exploit. Fix in the normal release cycle.'],
    ['LOW', '0.1 – 3.9', 'Minor impact. Fix when convenient.'],
    ['UNKNOWN', '—', 'Not yet rated by the advisory source.'],
  ])}
  <p class="fineprint">The severity is the one the advisory source assigned (the distribution or vendor of the package), which can differ from the NVD CVSS score shown.</p>
  <h3>About this report</h3>
  <p>The findings come from ${source}${m.image.scannedAt ? `, as of ${esc(formatWhen(m.image.scannedAt))}` : ''}. Each finding pairs a vulnerability ID with the affected package and its installed version; "Fixed in" is the version that resolves it according to the advisory.</p>
  <p>This is a point-in-time snapshot: new advisories are published every day, so an image with no findings today can have some tomorrow. Rescan regularly, and after every rebuild.</p>
  ${closingNote(m.generatedAt)}`;
}

/** model: buildReportModel(…) */
export function reportHtml(model) {
  const m = { ...model, sectionOf: {} };
  // Number the sections first: the executive summary refers to the secrets section.
  const plan = [
    ['summary', 'Executive summary', executiveSummary],
    ['image', 'Image details', imageDetails],
    ['actions', 'Recommended actions', actions],
    ['key', 'Critical and high findings', keyDetails],
    ['all', `All findings (${num(m.total)})`, allFindings],
    (m.secretsCount || m.secrets.length) && ['secrets', 'Exposed secrets', secrets],
    m.changes.length && ['changes', 'Changes since the previous version', changes],
  ].filter(Boolean);
  plan.forEach(([key], i) => { m.sectionOf[key] = i + 1; });

  return renderDocument({
    title: m.title,
    docType: 'Vulnerability report',
    eyebrow: 'Container image security assessment',
    heading: m.image.name || m.image.ref,
    subheading: m.image.location,
    risk: m.risk,
    noRisk: 'No known vulnerabilities',
    counts: m.counts,
    stats: [
      [num(m.total), 'total'],
      [num(m.fix.fixable), `with a fix (${pct(m.fix.fixable, m.total)}%)`],
      [m.upgrades.length, `package upgrade${m.upgrades.length === 1 ? '' : 's'}`],
      [m.secretsCount, `exposed secret${m.secretsCount === 1 ? '' : 's'}`],
    ],
    sections: plan.map(([key, title, render]) => ({ key, title, body: render(m) })),
    appendix: appendix(m),
    generatedAt: m.generatedAt,
  });
}

