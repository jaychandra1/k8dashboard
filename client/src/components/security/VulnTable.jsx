import { useMemo, useState } from 'react';
import Badge from '../ui/Badge';
import DataTable from '../ui/DataTable';
import Donut from '../ui/Donut';
import EmptyState from '../ui/EmptyState';
import { formatAgeLong } from '../../lib/format';
import useThemeTick from '../../hooks/useThemeTick';
import { SEVERITIES, sevColor, sevLabel, sevSegments, sevTotal, SevMini } from './severity';
import ImageName, { displayImage, splitImage } from './ImageName';

const sumOf = (segments) => segments.reduce((n, s) => n + (s.value > 0 ? s.value : 0), 0);

/**
 * Donut card with a heading and the legend list beside the ring. The ring's
 * centre shows `centerValue` (default: the sum of the segments) over
 * `centerLabel`; an empty chart keeps its `emptyText` instead.
 */
export function DonutCard({ title, segments, size = 130, centerLabel = 'total', centerValue, emptyText }) {
  const value = centerValue ?? sumOf(segments);
  const empty = sumOf(segments) === 0;
  return (
    <section className="sec-donut" aria-label={title}>
      <h3 className="sec-donut-title">{title}</h3>
      <Donut
        segments={segments} size={size} thickness={15} legend ariaLabel={title} emptyText={emptyText}
        centerValue={empty ? undefined : value.toLocaleString()} centerLabel={empty ? undefined : centerLabel}
      />
    </section>
  );
}

const imageKey = (im) => `${im.namespace || ''}/${im.image}`;

// Critical vulnerabilities of an image that have a fix: "6 of 8".
const criticalFix = (im) => {
  const crit = (im.vulnerabilities || []).filter((v) => v.severity === 'CRITICAL').length;
  return { crit, fixable: im.remediation?.fixableBySeverity?.CRITICAL ?? (im.vulnerabilities || []).filter((v) => v.severity === 'CRITICAL' && v.fixedVersion).length };
};
const STATUS_CLASS = { Failed: 'sec-crit', Scanning: 'sec-scanning' };
// Rows for images still running (or not yet scanned) — `active` is absent on
// pending rows and on servers older than the field.
const isRunning = (im) => im.active !== false;

/** What the image's rollout changed since the previous image of its Deployment. */
export function changeOf(im) {
  const changes = im.changes || [];
  if (!changes.length) return null;
  const resolved = {}; const introduced = {};
  for (const c of changes) {
    for (const k of SEVERITIES) {
      resolved[k] = (resolved[k] || 0) + (c.resolvedBySeverity?.[k] || 0);
      introduced[k] = (introduced[k] || 0) + (c.introducedBySeverity?.[k] || 0);
    }
  }
  return { resolved, introduced, fixed: sevTotal(resolved), added: sevTotal(introduced), from: changes[0].previousImage, changes };
}

const countsText = (s) => SEVERITIES.filter((k) => s[k]).map((k) => `${s[k]} ${sevLabel(k).toLowerCase()}`).join(', ') || 'none';

/** "▼ 3 fixed  ▲ 1 new" since the previous image; the detail is on hover. */
export function ChangeCell({ im }) {
  const ch = changeOf(im);
  if (!ch) return <span className="sec-dim">—</span>;
  const title = `Since ${splitImage(ch.from).name}: fixed ${countsText(ch.resolved)}; new ${countsText(ch.introduced)}`;
  if (!ch.fixed && !ch.added) return <span className="sec-dim" title={title}>No change</span>;
  return (
    <span className="sec-chg" title={title}>
      {ch.fixed > 0 && <span className="sec-chg-fixed" aria-label={`${ch.fixed} fixed since the previous version`}><span aria-hidden="true">▼</span> {ch.fixed} fixed</span>}
      {ch.added > 0 && <span className="sec-chg-new" aria-label={`${ch.added} new since the previous version`}><span aria-hidden="true">▲</span> {ch.added} new</span>}
    </span>
  );
}

const NOT_RUNNING_TIP = 'No pod runs this image any more — a newer revision replaced it. Its report is kept while the old ReplicaSet is (for rollback).';
const nameCell = (im) => (
  <ImageName image={im.image} badge={isRunning(im) ? null : <Badge tone="muted" size="sm" dot={false} className="sec-notrunning" title={NOT_RUNNING_TIP}>Not running</Badge>} />
);

/**
 * Overview (critical-only) and Images tabs: donut summaries + a sortable table
 * of images. onSelect(image) opens the finding drawer. Only images running now
 * are listed and counted; the ones a newer rollout replaced are behind a
 * toggle, and each running image shows what changed since the previous one.
 */
export default function VulnTable({ vuln, ns, q = '', onSelect, selected, criticalOnly = false, loading, refetching }) {
  useThemeTick();
  const [showInactive, setShowInactive] = useState(false);
  const ql = q.toLowerCase();
  const all = useMemo(() => vuln?.images || [], [vuln]);
  const running = useMemo(() => all.filter(isRunning), [all]);
  // Images tab: also the running images without a report yet — waiting,
  // being scanned, or whose scan failed (operator mode).
  const withPending = useMemo(() => {
    const keys = new Set(all.map(imageKey));
    const pending = (vuln?.pending || []).filter((pd) => !keys.has(imageKey(pd))).map((pd) => ({ ...pd, pending: true }));
    return [...all, ...pending];
  }, [all, vuln]);
  const inNs = (im) => !ns || ns === 'all' || im.namespace === ns || (im.workloads || []).some((w) => w.namespace === ns);
  const inactiveCount = all.filter((im) => !isRunning(im) && inNs(im) && (!criticalOnly || im.summary?.CRITICAL > 0)).length;
  const rows = useMemo(() => {
    let list = criticalOnly ? all.filter((im) => im.summary?.CRITICAL > 0) : withPending;
    if (!showInactive) list = list.filter(isRunning);
    if (ns && ns !== 'all') list = list.filter((im) => im.namespace === ns || (im.workloads || []).some((w) => w.namespace === ns));
    if (ql) list = list.filter((im) => displayImage(im.image).toLowerCase().includes(ql) || (im.namespace || '').toLowerCase().includes(ql) || (im.vulnerabilities || []).some((v) => v.id.toLowerCase().includes(ql)));
    return list;
  }, [all, withPending, ns, ql, criticalOnly, showInactive]);

  const statusSeg = [
    { label: 'Scanned', value: vuln?.scanned || 0, tone: 'muted' },
    { label: 'Not Scanned', value: vuln?.notScanned ?? 0, tone: 'info' },
  ];
  const resultSeg = [
    { label: 'Ok', value: vuln?.results?.ok || 0, tone: 'ok' },
    { label: 'Vulnerable', value: vuln?.results?.vulnerable || 0, tone: 'bad' },
  ];
  const vulnSeg = SEVERITIES.filter((k) => k !== 'UNKNOWN').map((k) => ({ label: sevLabel(k), value: vuln?.summary?.[k] || 0, color: sevColor(k) }));
  const exposed = running.filter((im) => (im.secrets || 0) > 0).length;
  const secretSeg = [{ label: 'Clean', value: running.length - exposed, tone: 'ok' }, { label: 'Exposed', value: exposed, tone: 'bad' }];
  const fixedSeg = sevSegments(vuln?.resolved?.bySeverity);

  const nameCol = {
    key: 'image', header: 'Name', sortable: true, ellipsis: true, width: criticalOnly ? 380 : 300,
    accessor: (im) => splitImage(im.image).name, title: (im) => displayImage(im.image), render: nameCell,
  };
  const changeCol = {
    key: 'change', header: criticalOnly ? 'Since last version' : 'Change', sortable: true,
    accessor: (im) => { const ch = changeOf(im); return ch ? ch.fixed - ch.added : -Infinity; },
    render: (im) => <ChangeCell im={im} />,
  };
  const columns = criticalOnly ? [
    nameCol,
    { key: 'namespace', header: 'Namespace', sortable: true, render: (im) => im.namespace || '—' },
    { key: 'critical', header: 'Critical', sortable: true, accessor: (im) => im.summary?.CRITICAL || 0, align: 'right',
      render: (im) => <span className={im.summary?.CRITICAL && isRunning(im) ? 'sec-crit' : 'sec-dim'}>{im.summary?.CRITICAL || 0}</span> },
    { key: 'fix', header: 'Fix available', sortable: true, accessor: (im) => criticalFix(im).fixable, render: (im) => {
      const { crit, fixable } = criticalFix(im);
      if (!crit) return <span className="sec-dim">—</span>;
      return <span className={fixable === crit ? 'sec-fix-all' : fixable ? 'sec-fix-some' : 'sec-dim'}>{fixable} of {crit}</span>;
    } },
    changeCol,
    { key: 'scannedAt', header: 'Scan Date', sortable: true, accessor: (im) => Date.parse(im.scannedAt) || 0, render: (im) => <span className="sec-dim">{im.scannedAt ? formatAgeLong(im.scannedAt) : '—'}</span> },
  ] : [
    nameCol,
    { key: 'platform', header: 'Platforms', sortable: true, accessor: (im) => im.platform || im.os || '', render: (im) => <span className="sec-dim">{im.platform || im.os || '—'}</span> },
    { key: 'pods', header: 'Pods', sortable: true, accessor: (im) => new Set((im.workloads || []).filter((w) => w.running !== false).map((w) => `${w.namespace}/${w.name}`)).size, align: 'right' },
    { key: 'vulns', header: 'Vulnerabilities', sortable: true, accessor: (im) => sevTotal(im.summary), render: (im) => {
      const scanned = im.status === 'Scanned' || im.status === 'Failed' || im.status === 'Not running';
      return sevTotal(im.summary) ? <SevMini summary={im.summary} /> : <span className="sec-dim">{scanned ? '—' : '?'}</span>;
    } },
    changeCol,
    { key: 'secrets', header: 'Secrets', sortable: true, accessor: (im) => im.secrets || 0, align: 'right', render: (im) => {
      const scanned = im.status === 'Scanned' || im.status === 'Failed' || im.status === 'Not running';
      if (!scanned) return <span className="sec-dim">?</span>;
      return im.secrets ? <span className="sec-secretnum">{im.secrets}</span> : <span className="sec-dim">—</span>;
    } },
    { key: 'status', header: 'Status', sortable: true, accessor: (im) => im.status || 'Not Scanned', render: (im) => <span className={STATUS_CLASS[im.status] || 'sec-dim'}>{im.status || 'Not Scanned'}</span> },
  ];

  const initialSort = criticalOnly ? { key: 'scannedAt', dir: 'desc' } : { key: 'image', dir: 'asc' };
  const inactiveToggle = inactiveCount > 0 && (
    <label className="sec-inactive-toggle">
      <input type="checkbox" className="ck" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      Show {inactiveCount} {inactiveCount === 1 ? 'image' : 'images'} no longer running
    </label>
  );
  return (
    <>
      <div className="sec-donuts">
        <DonutCard title="Status" segments={statusSeg} centerLabel="images" />
        <DonutCard title="Results" segments={resultSeg} centerLabel="scanned" />
        <DonutCard title="Vulnerabilities" segments={vulnSeg} />
        {criticalOnly
          ? <DonutCard title="Fixed since last version" segments={fixedSeg} centerLabel="fixed" emptyText="none yet" />
          : <DonutCard title="Exposed Secrets" segments={secretSeg} centerValue={exposed} centerLabel="exposed" />}
      </div>
      <div className="sec-table-head">
        {criticalOnly ? <h2 className="sec-section-title">Latest critical vulnerabilities</h2> : <span />}
        {inactiveToggle}
      </div>
      <DataTable
        caption={criticalOnly ? 'Running images with critical vulnerabilities' : 'Scanned images'}
        columns={columns}
        rows={rows}
        rowKey={imageKey}
        rowName={(im) => displayImage(im.image)}
        getRowTone={(im) => (isRunning(im) ? undefined : 'inactive')}
        rowHeight={52}
        activeKey={selected ? imageKey(selected) : null}
        onRowActivate={onSelect}
        loading={loading}
        refetching={refetching}
        emptyState={(
          <EmptyState icon="shieldCheck" title={`No ${criticalOnly ? 'critical ' : ''}image findings${q ? ' match your search' : ''}.`} />
        )}
        initialSort={initialSort}
        storageKey={criticalOnly ? 'security-critical' : 'security-images'}
        className="sec-dt"
      />
      {criticalOnly && <RecentFixes images={running} ns={ns} onSelect={onSelect} />}
    </>
  );
}

/**
 * The latest rollouts and what each changed: Deployment, previous → current
 * image, vulnerabilities fixed and introduced. A row opens the current image.
 */
function RecentFixes({ images, ns, onSelect }) {
  const rows = useMemo(() => {
    const out = [];
    for (const im of images) {
      for (const c of im.changes || []) {
        if (ns && ns !== 'all' && c.namespace !== ns) continue;
        if (!sevTotal(c.resolvedBySeverity) && !sevTotal(c.introducedBySeverity)) continue;
        out.push({ ...c, im, key: `${c.namespace}|${c.workload}|${c.container}` });
      }
    }
    return out;
  }, [images, ns]);
  if (!rows.length) return null;
  return (
    <>
      <h2 className="sec-section-title sec-section-gap">Fixed since the previous version</h2>
      <DataTable
        caption="What the latest rollouts fixed and introduced"
        columns={[
          { key: 'workload', header: 'Workload', sortable: true, render: (r) => (
            <span className="sec-imgname">
              <span className="sec-imgname-main"><span className="sec-imgname-text">{r.workload.replace(/^Deployment /, '')}</span></span>
              <span className="sec-imgname-loc">{r.namespace}{r.container ? ` · ${r.container}` : ''}</span>
            </span>
          ) },
          { key: 'images', header: 'Image', ellipsis: true, width: 420, title: (r) => `${displayImage(r.previousImage)} → ${displayImage(r.im.image)}`, render: (r) => (
            <span className="sec-imgchange">
              <span className="sec-dim">{splitImage(r.previousImage).name}</span>
              <span className="sec-imgchange-arrow" aria-label="replaced by">→</span>
              <span>{splitImage(r.im.image).name}</span>
            </span>
          ) },
          { key: 'fixed', header: 'Fixed', sortable: true, accessor: (r) => sevTotal(r.resolvedBySeverity), render: (r) => (
            sevTotal(r.resolvedBySeverity) ? <span className="sec-chg-sev sec-chg-sev-fixed"><SevMini summary={r.resolvedBySeverity} /></span> : <span className="sec-dim">—</span>
          ) },
          { key: 'introduced', header: 'New', sortable: true, accessor: (r) => sevTotal(r.introducedBySeverity), render: (r) => (
            sevTotal(r.introducedBySeverity) ? <SevMini summary={r.introducedBySeverity} /> : <span className="sec-dim">—</span>
          ) },
          { key: 'revision', header: 'Revision', align: 'right', render: (r) => <span className="sec-dim">{r.previousRevision} → {r.revision}</span> },
        ]}
        rows={rows}
        rowKey={(r) => r.key}
        rowName={(r) => r.workload}
        rowHeight={52}
        onRowActivate={(r) => onSelect?.(r.im)}
        initialSort={{ key: 'fixed', dir: 'desc' }}
        storageKey="security-recent-fixes"
        className="sec-dt"
      />
    </>
  );
}

export { VulnTable };
