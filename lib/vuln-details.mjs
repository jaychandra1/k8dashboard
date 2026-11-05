// Advisory details for the vulnerability report download: the description,
// dates, CVSS vector and reference links of each finding. Both sources carry
// them — Trivy Operator VulnerabilityReports (camelCase) and the Trivy CLI's
// JSON (PascalCase) — but the image list leaves them out: they are most of a
// report's size and only the downloaded report needs them.

const MAX_DESCRIPTION = 4000;
const MAX_LINKS = 10;

export const detailKey = (id, pkg, installedVersion) => `${id || ''}|${pkg || ''}|${installedVersion || ''}`;

const text = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

/** http(s) links only, deduplicated, primary first. */
export function httpLinks(primary, links) {
  const out = [];
  for (const l of [primary, ...(Array.isArray(links) ? links : [])]) {
    if (typeof l !== 'string') continue;
    const u = l.trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(u) || u.length > 500 || out.includes(u)) continue;
    out.push(u);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

/**
 * The CVSS vector to show: from the source the severity came from, else NVD,
 * else the first vendor that has one. CVSS v4 wins over v3 where both exist.
 * { cvss: { nvd: { V3Vector, V3Score, V40Vector, V40Score }, … } } →
 * { cvssVector, cvssScore, cvssSource }
 */
export function pickCvss(cvss, preferred) {
  if (!cvss || typeof cvss !== 'object') return {};
  const sources = [...new Set([preferred, 'nvd', 'redhat', 'ghsa', ...Object.keys(cvss)].filter(Boolean))];
  for (const src of sources) {
    const c = cvss[src];
    if (!c || typeof c !== 'object') continue;
    const vector = c.V40Vector || c.V3Vector || c.V2Vector;
    if (typeof vector !== 'string' || !vector) continue;
    const score = c.V40Vector ? c.V40Score : c.V3Vector ? c.V3Score : c.V2Score;
    return { cvssVector: text(vector, 200), cvssScore: Number.isFinite(score) ? score : undefined, cvssSource: text(src, 40) };
  }
  return {};
}

const finding = ({ id, pkg, installedVersion, description, publishedDate, lastModifiedDate, cvss, cvssSource, primary, links }) => ({
  id: text(id), pkg: text(pkg), installedVersion: text(installedVersion),
  description: text(description, MAX_DESCRIPTION),
  publishedDate: text(publishedDate, 40), lastModifiedDate: text(lastModifiedDate, 40),
  ...pickCvss(cvss, cvssSource),
  links: httpLinks(primary, links),
});

/** One Trivy Operator VulnerabilityReport entry → details. */
export const operatorDetail = (v = {}) => finding({
  id: v.vulnerabilityID, pkg: v.resource, installedVersion: v.installedVersion,
  description: v.description, publishedDate: v.publishedDate, lastModifiedDate: v.lastModifiedDate,
  cvss: v.cvss, cvssSource: v.cvsssource || v.cvssSource, primary: v.primaryLink, links: v.links,
});

/** One Trivy CLI (`trivy image --format json`) vulnerability → details. */
export const cliDetail = (v = {}) => finding({
  id: v.VulnerabilityID, pkg: v.PkgName, installedVersion: v.InstalledVersion,
  description: v.Description, publishedDate: v.PublishedDate, lastModifiedDate: v.LastModifiedDate,
  cvss: v.CVSS, cvssSource: v.SeveritySource, primary: v.PrimaryURL, links: v.References,
});

/** Deduplicate by (id, package, installed version), first wins. */
export function uniqueDetails(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const k = detailKey(d.id, d.pkg, d.installedVersion);
    if (!d.id || seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}
