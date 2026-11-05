// The reports as CSV: one row per finding (a CVE, or a failed check), for
// Jira / Excel / ticket imports. UTF-8 with a BOM (so Excel reads the
// encoding), CRLF line ends, every field quoted.
import { SEV_LABEL } from './shared';

/**
 * Quote a field. A value starting with = + - @ (or a tab / CR) is prefixed
 * with ' so a spreadsheet shows it as text instead of running it as a
 * formula (CSV injection).
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const iso = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
};

const table = (columns, rows) => {
  const lines = [columns.map(([h]) => csvCell(h)).join(',')];
  for (const row of rows) lines.push(columns.map(([, get]) => csvCell(get(row))).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
};

/** Image vulnerabilities: one row per CVE. */
export function reportCsv(model) {
  const i = model.image;
  const columns = [
    ['Vulnerability ID', (f) => f.id],
    ['Severity', (f) => SEV_LABEL[f.severity]],
    ['CVSS score', (f) => (f.score == null ? '' : Number(f.score).toFixed(1))],
    ['CVSS vector', (f) => f.cvssVector],
    ['Package', (f) => f.pkg],
    ['Installed version', (f) => f.installedVersion],
    ['Fixed version', (f) => f.fixedVersion],
    ['Fix available', (f) => (f.fixedVersion ? 'Yes' : 'No')],
    ['Package type', (f) => [f.kind, f.packageType].filter(Boolean).join(' / ')],
    ['Location', (f) => f.location],
    ['Title', (f) => f.title],
    ['Description', (f) => f.description],
    ['Published', (f) => f.publishedDate],
    ['Last modified', (f) => f.lastModifiedDate],
    ['Advisory', (f) => f.link],
    ['References', (f) => f.links.join(' ')],
    ['Image', () => i.ref],
    ['Tag', () => i.tag],
    ['Digest', () => i.digest],
    ['Namespace', () => i.namespace],
    ['Cluster', () => i.context],
    ['Scanned', () => iso(i.scannedAt)],
  ];
  return table(columns, model.findings);
}

/** Resource checks (configuration audit / RBAC): one row per failed check. */
export function checksCsv(model) {
  const r = model.resource;
  return table([
    ['Check ID', (c) => c.id],
    ['Severity', (c) => SEV_LABEL[c.severity]],
    ['Title', (c) => c.title],
    ['Category', (c) => c.category],
    ['Finding', (c) => c.messages.join(' | ')],
    ['How to fix', (c) => c.remediation],
    ['Description', (c) => c.description],
    ['Kind', () => r.kind],
    ['Name', () => r.name],
    ['Namespace', () => r.namespace],
    ['Cluster', () => r.context],
    ['Checked', () => iso(r.scannedAt)],
  ], model.checks);
}
