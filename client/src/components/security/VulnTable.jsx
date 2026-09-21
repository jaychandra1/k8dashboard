import { useMemo } from 'react';
import DataTable from '../ui/DataTable';
import Donut from '../ui/Donut';
import EmptyState from '../ui/EmptyState';
import { formatAgeLong } from '../../lib/format';
import useThemeTick from '../../hooks/useThemeTick';
import { SEVERITIES, sevColor, sevLabel, sevTotal, SevMini } from './severity';

/** Donut card with a heading and the legend list beside the ring. */
export function DonutCard({ title, segments, size = 130 }) {
  return (
    <section className="sec-donut" aria-label={title}>
      <h3 className="sec-donut-title">{title}</h3>
      <Donut segments={segments} size={size} thickness={15} legend ariaLabel={title} />
    </section>
  );
}

const imageKey = (im) => `${im.namespace || ''}/${im.image}`;

/**
 * Overview (critical-only) and Images tabs: donut summaries + a sortable table
 * of images. onSelect(image) opens the finding drawer.
 */
export default function VulnTable({ vuln, ns, q = '', onSelect, selected, criticalOnly = false, loading, refetching }) {
  useThemeTick();
  const ql = q.toLowerCase();
  const all = useMemo(() => vuln?.images || [], [vuln]);
  const rows = useMemo(() => {
    let list = criticalOnly ? all.filter((im) => im.summary?.CRITICAL > 0) : all;
    if (ns && ns !== 'all') list = list.filter((im) => im.namespace === ns || (im.workloads || []).some((w) => w.namespace === ns));
    if (ql) list = list.filter((im) => im.image.toLowerCase().includes(ql) || (im.namespace || '').toLowerCase().includes(ql) || (im.vulnerabilities || []).some((v) => v.id.toLowerCase().includes(ql)));
    return list;
  }, [all, ns, ql, criticalOnly]);

  const statusSeg = [
    { label: 'Scanned', value: vuln?.scanned || 0, tone: 'muted' },
    { label: 'Not Scanned', value: vuln?.notScanned ?? 0, tone: 'info' },
  ];
  const resultSeg = [
    { label: 'Ok', value: vuln?.results?.ok || 0, tone: 'ok' },
    { label: 'Vulnerable', value: vuln?.results?.vulnerable || 0, tone: 'bad' },
  ];
  const vulnSeg = SEVERITIES.filter((k) => k !== 'UNKNOWN').map((k) => ({ label: sevLabel(k), value: vuln?.summary?.[k] || 0, color: sevColor(k) }));
  const exposed = all.filter((im) => (im.secrets || 0) > 0).length;
  const secretSeg = [{ label: 'Clean', value: all.length - exposed, tone: 'ok' }, { label: 'Exposed', value: exposed, tone: 'bad' }];

  const columns = criticalOnly ? [
    { key: 'image', header: 'Name', sortable: true, ellipsis: true, width: 360, mono: true, className: 'sec-mono', render: (im) => im.image },
    { key: 'namespace', header: 'Namespace', sortable: true, render: (im) => im.namespace || '—' },
    { key: 'kind', header: 'Kind', render: () => <span className="sec-kind">OciImage</span> },
    { key: 'critical', header: 'Critical', sortable: true, accessor: (im) => im.summary?.CRITICAL || 0, align: 'right',
      render: (im) => <span className={im.summary?.CRITICAL ? 'sec-crit' : ''}>{im.summary?.CRITICAL || 0}</span> },
    { key: 'scannedAt', header: 'Scan Date', sortable: true, accessor: (im) => Date.parse(im.scannedAt) || 0, render: (im) => <span className="sec-dim">{im.scannedAt ? formatAgeLong(im.scannedAt) : '—'}</span> },
  ] : [
    { key: 'image', header: 'Name', sortable: true, ellipsis: true, width: 340, mono: true, className: 'sec-mono', render: (im) => im.image },
    { key: 'platform', header: 'Platforms', sortable: true, accessor: (im) => im.platform || im.os || '', render: (im) => <span className="sec-dim">{im.platform || im.os || '—'}</span> },
    { key: 'pods', header: 'Pods', sortable: true, accessor: (im) => new Set((im.workloads || []).map((w) => `${w.namespace}/${w.name}`)).size, align: 'right' },
    { key: 'vulns', header: 'Vulnerabilities', sortable: true, accessor: (im) => sevTotal(im.summary), render: (im) => {
      const scanned = im.status === 'Scanned' || im.status === 'Failed';
      return sevTotal(im.summary) ? <SevMini summary={im.summary} /> : <span className="sec-dim">{scanned ? '—' : '?'}</span>;
    } },
    { key: 'secrets', header: 'Exposed Secrets', sortable: true, accessor: (im) => im.secrets || 0, align: 'right', render: (im) => {
      const scanned = im.status === 'Scanned' || im.status === 'Failed';
      if (!scanned) return <span className="sec-dim">?</span>;
      return im.secrets ? <span className="sec-secretnum">{im.secrets}</span> : <span className="sec-dim">—</span>;
    } },
    { key: 'status', header: 'Status', sortable: true, accessor: (im) => im.status || 'Not Scanned', render: (im) => <span className={im.status === 'Failed' ? 'sec-crit' : 'sec-dim'}>{im.status || 'Not Scanned'}</span> },
  ];

  const initialSort = criticalOnly ? { key: 'scannedAt', dir: 'desc' } : { key: 'image', dir: 'asc' };
  return (
    <>
      <div className="sec-donuts">
        <DonutCard title="Status" segments={statusSeg} />
        <DonutCard title="Results" segments={resultSeg} />
        <DonutCard title="Vulnerabilities" segments={vulnSeg} />
        {!criticalOnly && <DonutCard title="Exposed Secrets" segments={secretSeg} />}
      </div>
      {criticalOnly && <h2 className="sec-section-title">Latest critical vulnerabilities</h2>}
      <DataTable
        caption={criticalOnly ? 'Images with critical vulnerabilities' : 'Scanned images'}
        columns={columns}
        rows={rows}
        rowKey={imageKey}
        rowName={(im) => im.image}
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
    </>
  );
}

export { VulnTable };
