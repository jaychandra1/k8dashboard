// What every downloadable security report shares: escaping, dates, severity
// labels, and the page itself — one self-contained HTML document with inline
// CSS, no scripts and no external requests (a CSP says so). It reads well on
// screen and is laid out for A4 print: the desktop app turns the same document
// into the PDF, and a browser's "Save as PDF" gives the same result.
//
// The reports carry no product name or logo: they are about the cluster's
// images and resources, and are shared with other teams as they are.

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
export const SEV_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', UNKNOWN: 'Unknown' };
export const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
export const sevOf = (s) => {
  const v = String(s || '').toUpperCase();
  return SEV_RANK[v] != null ? v : 'UNKNOWN';
};
export const emptyCounts = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const link = (href, label) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label));
/** Escaped, with line-break opportunities after . : / @ - (package names, paths). */
export const breakable = (s) => esc(s).replace(/([.:/@-])/g, '$1<wbr>');
export const pill = (s) => `<span class="sev sev-${s.toLowerCase()}">${SEV_LABEL[s]}</span>`;
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const join = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
/** "2 critical, 6 high and 4 medium" (parts as a list; join() them). */
export const sevBreakdown = (counts) => SEVERITIES.filter((s) => counts[s]).map((s) => `${num(counts[s])} ${SEV_LABEL[s].toLowerCase()}`);
export const props = (rows) => `<dl class="props">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** "5 November 2026, 14:32 (2026-11-05 09:02 UTC)" — local time, with UTC for readers elsewhere. */
export function formatWhen(v) {
  const d = asDate(v);
  if (!d) return '';
  const local = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${local} (${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
}
/** "10 Mar 2025" */
export const formatDay = (v) => {
  const d = asDate(v);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}` : '';
};

/** File-name part: letters, digits, . _ - only. */
export const slug = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
/** "2026-11-05", in local time. */
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The severity scale, for an appendix: rows of [severity, ...cells]. */
export function severityTable(headers, rows) {
  return `<table class="grid compact">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([s, ...cells]) => `<tr><td>${pill(s)}</td>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

/** The closing lines of every appendix. */
export const closingNote = (generatedAt) => `<p class="fineprint">Generated on ${esc(formatWhen(generatedAt))}. This report describes the security of internal systems: share it on a need-to-know basis.</p>`;

const CSS = `
:root { --ink:#0f172a; --muted:#475569; --faint:#64748b; --line:#e2e8f0; --panel:#f8fafc; --accent:#2563eb;
  --crit:#b91c1c; --crit-bg:#fef2f2; --high:#c2410c; --high-bg:#fff7ed; --med:#a16207; --med-bg:#fefce8;
  --low:#1d4ed8; --low-bg:#eff6ff; --unk:#475569; --unk-bg:#f1f5f9; --ok:#15803d; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #e9edf3; color: var(--ink); font: 13px/1.55 "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
.page { max-width: 980px; margin: 28px auto; background: #fff; padding: 44px 52px 36px; border-radius: 6px; box-shadow: 0 1px 3px rgba(15,23,42,.08), 0 12px 32px rgba(15,23,42,.08); }
.print-hint { max-width: 980px; margin: 18px auto -14px; color: var(--faint); font-size: 12px; text-align: right; }
code, .mono { font-family: "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; font-size: 11.5px; }
code.wrap { word-break: break-all; }
code.ok { color: var(--ok); font-weight: 600; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.dim { color: var(--faint); }
.nowrap { white-space: nowrap; }
.doc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding-bottom: 12px; border-bottom: 3px solid transparent; border-image: linear-gradient(90deg, #38bdf8, #3b82f6 45%, #7c3aed) 1; }
.doc-type { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink); }
.doc-meta { text-align: right; color: var(--muted); font-size: 11.5px; line-height: 1.45; }
.cover { padding: 26px 0 8px; }
.eyebrow { margin: 0 0 6px; color: var(--accent); font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -.4px; word-break: break-word; }
.cover .loc { margin: 4px 0 0; color: var(--faint); font-size: 12px; word-break: break-all; }
.risk { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; padding: 6px 12px; border-radius: 999px; font-weight: 600; font-size: 12.5px; border: 1px solid; }
.risk-critical { color: var(--crit); background: var(--crit-bg); border-color: #fecaca; }
.risk-high { color: var(--high); background: var(--high-bg); border-color: #fed7aa; }
.risk-medium { color: var(--med); background: var(--med-bg); border-color: #fde68a; }
.risk-low { color: var(--low); background: var(--low-bg); border-color: #bfdbfe; }
.risk-unknown { color: var(--unk); background: var(--unk-bg); border-color: var(--line); }
.risk-none { color: var(--ok); background: #f0fdf4; border-color: #bbf7d0; }
.tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 22px 0 6px; }
.tile { border: 1px solid var(--line); border-top: 4px solid var(--unk); border-radius: 6px; padding: 10px 12px; background: #fff; break-inside: avoid; }
.tile .n { font-size: 24px; font-weight: 700; line-height: 1.1; }
.tile .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.tile-critical { border-top-color: var(--crit); } .tile-critical .n { color: var(--crit); }
.tile-high { border-top-color: var(--high); } .tile-high .n { color: var(--high); }
.tile-medium { border-top-color: var(--med); } .tile-medium .n { color: var(--med); }
.tile-low { border-top-color: var(--low); } .tile-low .n { color: var(--low); }
.stats { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 10px 0 0; color: var(--muted); font-size: 12px; }
.stats strong { color: var(--ink); }
h2 { font-size: 16px; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); break-after: avoid; letter-spacing: -.1px; }
h2 .num-label { color: var(--accent); margin-right: 6px; }
h3 { font-size: 13.5px; margin: 20px 0 8px; break-after: avoid; }
p { margin: 0 0 10px; }
.lead-in { color: var(--muted); margin-bottom: 8px; }
.note { color: var(--muted); background: var(--panel); border-left: 3px solid var(--line); padding: 8px 12px; border-radius: 0 4px 4px 0; }
.fineprint { color: var(--faint); font-size: 11.5px; }
.callout { border: 1px solid #fecaca; background: linear-gradient(180deg, #fff5f5, #fff); border-radius: 6px; padding: 12px 16px; margin: 12px 0 4px; break-inside: avoid; }
.callout-title { font-weight: 700; color: var(--crit); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.callout ul { margin: 0; padding-left: 18px; }
.callout li { margin: 5px 0; }
.callout-sub { color: var(--muted); font-size: 12px; }
dl.props { display: grid; grid-template-columns: 160px 1fr; margin: 0; border-top: 1px solid var(--line); }
dl.props dt, dl.props dd { padding: 7px 0; border-bottom: 1px solid var(--line); margin: 0; }
dl.props dt { color: var(--muted); }
dl.props dd { min-width: 0; word-break: break-word; }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li + li { margin-top: 2px; }
ol.tips { margin: 0 0 6px; padding-left: 20px; }
ol.tips li { margin: 6px 0; }
table.grid { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 12px; }
table.grid th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--panel); border-bottom: 1px solid var(--line); padding: 7px 8px; }
table.grid td { border-bottom: 1px solid var(--line); padding: 7px 8px; vertical-align: top; overflow-wrap: break-word; }
table.grid tbody tr:nth-child(even) td { background: #fcfdfe; }
table.grid .num { text-align: right; white-space: nowrap; }
table.grid .sub { color: var(--faint); font-size: 11px; margin-top: 2px; }
table.grid .sub-title { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
table.findings td:nth-child(2) { width: 34%; }
table.compact td { padding: 5px 8px; }
/* Versions stay whole ("4.2.11.Final"); a list of fixed versions wraps after its commas. */
table.grid td.ver { word-break: normal; overflow-wrap: normal; }
table.findings td:nth-child(5) { width: 26%; }
table.checks td:nth-child(2) { width: 38%; }
ul.msgs { margin: 0; padding-left: 16px; }
ul.msgs li + li { margin-top: 3px; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
.sev { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700; letter-spacing: .02em; white-space: nowrap; border: 1px solid; }
.sev-critical { color: var(--crit); background: var(--crit-bg); border-color: #fecaca; }
.sev-high { color: var(--high); background: var(--high-bg); border-color: #fed7aa; }
.sev-medium { color: var(--med); background: var(--med-bg); border-color: #fde68a; }
.sev-low { color: var(--low); background: var(--low-bg); border-color: #bfdbfe; }
.sev-unknown { color: var(--unk); background: var(--unk-bg); border-color: var(--line); }
.tag { display: inline-block; padding: 0 7px; border-radius: 4px; font-size: 10.5px; font-weight: 700; }
.tag-ok { color: var(--ok); background: #f0fdf4; } .tag-bad { color: var(--crit); background: var(--crit-bg); }
.card { border: 1px solid var(--line); border-left: 4px solid var(--unk); border-radius: 6px; padding: 12px 16px; margin: 0 0 12px; break-inside: avoid; }
.card-critical { border-left-color: var(--crit); } .card-high { border-left-color: var(--high); }
.card header { display: flex; align-items: center; gap: 10px; }
.card-id { font-weight: 700; font-size: 14px; }
.card-title { font-weight: 600; margin: 4px 0 8px; }
dl.card-meta { display: grid; grid-template-columns: 90px 1fr; gap: 3px 12px; margin: 0 0 8px; font-size: 12px; }
dl.card-meta dt { color: var(--muted); }
dl.card-meta dd { margin: 0; min-width: 0; word-break: break-word; }
dl.card-meta .sub { color: var(--faint); font-size: 11px; word-break: break-all; }
.desc { white-space: pre-line; color: #1e293b; margin: 6px 0 8px; }
.fix { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; padding: 7px 10px; margin: 6px 0 2px; font-size: 12px; }
.fix strong { color: var(--ok); }
.refs-title { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
ul.refs { margin: 2px 0 0; padding-left: 18px; font-size: 11.5px; word-break: break-all; }
.doc-foot { margin-top: 28px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--faint); font-size: 11px; display: flex; justify-content: space-between; gap: 12px; }
@page { size: A4; margin: 16mm 14mm 18mm; }
@media print {
  body { background: #fff; font-size: 12px; }
  .page { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; }
  .print-hint { display: none; }
  a { color: var(--accent); }
  h2 { break-after: avoid; }
}
/* Phones only: an A4 page is ~690 CSS px wide in print and must keep the desktop layout. */
@media screen and (max-width: 720px) {
  .page { margin: 0; padding: 24px 18px; border-radius: 0; }
  .tiles { grid-template-columns: repeat(3, 1fr); }
  dl.props { grid-template-columns: 1fr; }
  dl.props dt { border-bottom: none; padding-bottom: 0; }
  table.grid { display: block; overflow-x: auto; }
}
`;

/**
 * The report page.
 *   title      document title (also the PDF footer's left side)
 *   docType    "Vulnerability report", top left
 *   eyebrow, heading, subheading   the cover
 *   risk       worst severity, or null → noRisk ("No known vulnerabilities")
 *   counts     per severity (the tiles); stats: [[n, label], …] beneath them
 *   sections   [{ key, title, body }] in order (numbered 1., 2., …)
 *   appendix   HTML of the appendix
 */
export function renderDocument({ title, docType, eyebrow, heading, subheading = '', risk, noRisk, counts, stats = [], sections, appendix, generatedAt }) {
  const riskLabel = risk ? `${SEV_LABEL[risk]} risk` : noRisk;
  const tiles = SEVERITIES.map((s) => `<div class="tile tile-${s.toLowerCase()}"><div class="n">${num(counts[s])}</div><div class="l">${SEV_LABEL[s]}</div></div>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<p class="print-hint">To save this report as a PDF, print it and choose “Save as PDF”.</p>
<main class="page">
  <header class="doc-head">
    <div class="doc-type">${esc(docType)}</div>
    <div class="doc-meta">Generated ${esc(formatWhen(generatedAt))}</div>
  </header>
  <section class="cover">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(heading)}</h1>
    ${subheading ? `<p class="loc">${esc(subheading)}</p>` : ''}
    <div class="risk risk-${risk ? risk.toLowerCase() : 'none'}">Overall: ${esc(riskLabel)}</div>
    <div class="tiles">${tiles}</div>
    <div class="stats">${stats.map(([n, label]) => `<span><strong>${esc(n)}</strong> ${esc(label)}</span>`).join('')}</div>
  </section>
  ${sections.map((s, i) => `<section id="${esc(s.key)}"><h2><span class="num-label">${i + 1}.</span>${esc(s.title)}</h2>${s.body}</section>`).join('\n  ')}
  <section id="appendix"><h2><span class="num-label">A.</span>Appendix</h2>${appendix}</section>
  <footer class="doc-foot"><span>${esc(docType)} · ${esc(heading)}</span><span>Internal: contains security findings</span></footer>
</main>
</body>
</html>
`;
}
