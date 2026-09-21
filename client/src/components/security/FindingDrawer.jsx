import { afterPaint } from '../../lib/a11y';
import { useEffect, useId, useRef, useState } from 'react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Donut from '../ui/Donut';
import DataTable from '../ui/DataTable';
import EmptyState from '../ui/EmptyState';
import useClickOutside from '../../hooks/useClickOutside';
import useThemeTick from '../../hooks/useThemeTick';
import { formatAgeLong } from '../../lib/format';
import { KIND_TYPE, kindType } from '../../lib/kinds';
import { navToNamespace, navToPods, navToResource } from '../shared/nav';
import { withKeys } from '../shared/keys';
import { SevPill, SevFilter, sevSegments, worstSeverity } from './severity';

function Prop({ k, children }) {
  return <div className="sec-prop"><span className="sec-prop-k">{k}</span><span className="sec-prop-v">{children}</span></div>;
}

/** In-text navigation link rendered as a real button. */
function LinkButton({ onClick, children }) {
  return <button type="button" className="sec-linkbtn" onClick={onClick}>{children}</button>;
}

/**
 * Right-hand finding details. A non-modal dialog: focus moves in on open,
 * Escape (or the close button, or an outside click) closes it and focus
 * returns to where it was.
 */
export default function FindingDrawer({ detail, onClose, onNavigate }) {
  const id = useId();
  const ref = useRef(null);
  const isImage = detail.type === 'image';
  const d = detail.data;
  useClickOutside(ref, onClose, true);

  // Focus in on mount, restore on unmount (refs only → no deps).
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const cancelRaf = afterPaint(() => ref.current?.focus({ preventScroll: true }));
    return () => {
      cancelRaf();
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
        try { previous.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, []);

  return (
    <aside
      ref={ref}
      className="sec-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="sec-drawer-head">
        <h2 id={`${id}-title`} className="sec-drawer-title">
          {isImage ? <><span className="sec-kind">OciImage</span> {d.image}</> : <><span className="sec-kind">{d.kind}</span> {d.name}</>}
        </h2>
        <Tooltip content="Close">
          <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel="Close finding details" className="sec-drawer-x" onClick={onClose} />
        </Tooltip>
      </div>
      <div className="sec-drawer-body">
        {isImage
          ? <ImageDetail key={`${d.namespace || ''}/${d.image}`} d={d} onNavigate={onNavigate} />
          : <ChecksDetail key={`${d.kind}/${d.namespace}/${d.name}`} d={d} onNavigate={onNavigate} />}
      </div>
    </aside>
  );
}

function ImageDetail({ d, onNavigate }) {
  useThemeTick();
  const [sevFilter, setSevFilter] = useState(null);
  const workloads = d.workloads || [];
  const controlledBy = workloads[0];
  const toggleSev = (k) => setSevFilter((f) => (f === k ? null : k));
  const vulns = d.vulnerabilities || [];
  const shown = sevFilter ? vulns.filter((v) => v.severity === sevFilter) : vulns;
  const canNav = !!onNavigate;
  return (
    <>
      <h3 className="sec-drawer-section">Properties</h3>
      <Prop k="Name"><span className="sec-mono">{d.image}</span></Prop>
      <Prop k="Namespace">{d.namespace && canNav ? <LinkButton onClick={() => navToNamespace(onNavigate, d.namespace)}>{d.namespace}</LinkButton> : (d.namespace || '—')}</Prop>
      {controlledBy && (
        <Prop k="Controlled By">
          {controlledBy.kind}{' '}
          {canNav ? <LinkButton onClick={() => navToResource(onNavigate, { type: kindType(controlledBy.kind), namespace: controlledBy.namespace, name: controlledBy.name })}>{controlledBy.name}</LinkButton> : controlledBy.name}
        </Prop>
      )}
      {d.tag && <Prop k="Tag">{d.tag}</Prop>}
      {d.digest && <Prop k="Image Digest"><span className="sec-mono sec-break">{d.digest}</span></Prop>}
      <Prop k="Status">{d.status}</Prop>
      <Prop k="Used By Pods">
        <span className="sec-podlinks">
          {withKeys(workloads.slice(0, 30), (w) => `${w.namespace}/${w.name}`).map(({ key, item: w }) => (
            <span className="sec-podlink" key={key}>
              {canNav ? <LinkButton onClick={() => navToNamespace(onNavigate, w.namespace)}>{w.namespace}</LinkButton> : w.namespace}
              <span className="sec-podlink-sep">/</span>
              {canNav ? <LinkButton onClick={() => navToPods(onNavigate, w.namespace, w.name)}>{w.name}</LinkButton> : w.name}
            </span>
          ))}
        </span>
      </Prop>

      <h3 className="sec-drawer-section">Vulnerabilities</h3>
      <div className="sec-drawer-donut">
        <Donut segments={sevSegments(d.summary)} size={120} thickness={15} ariaLabel="Vulnerabilities by severity" onSegmentClick={toggleSev} activeKey={sevFilter} />
      </div>
      <SevFilter summary={d.summary} active={sevFilter} onToggle={toggleSev} onClear={() => setSevFilter(null)} what="vulnerabilities" />
      <Prop k="Severity"><SevPill s={worstSeverity(d.summary)} /></Prop>
      <Prop k="Scanned">{d.scannedAt ? formatAgeLong(d.scannedAt) : '—'}</Prop>
      {d.scanner && <Prop k="Scan Result Source">{d.scanner}</Prop>}
      <Prop k="Exposed Secrets">{d.secrets ? <span className="sec-secretnum">{d.secrets}</span> : <span className="sec-dim">None</span>}</Prop>

      {d.secretsList?.length > 0 && (
        <ul className="sec-checks sec-checks-gap" aria-label="Exposed secrets">
          {withKeys(d.secretsList, (s) => `${s.ruleID}|${s.target}|${s.line || ''}`).map(({ key, item: s }) => (
            <li className="sec-checkitem" key={key}>
              <SevPill s={s.severity} />
              <div className="sec-check-main">
                <div className="sec-check-title">{s.title || s.ruleID} <code>{s.ruleID}</code></div>
                <div className="sec-check-msg">{s.target}{s.line ? `:${s.line}` : ''}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="sec-drawer-table">
        <DataTable
          caption={`Vulnerabilities in ${d.image}`}
          dense
          columns={[
            { key: 'id', header: 'ID', sortable: true, render: (v) => (v.link ? <a href={v.link} target="_blank" rel="noreferrer" className="sec-cve">{v.id}<span className="sr-only"> (opens in a new tab)</span></a> : v.id) },
            { key: 'severity', header: 'Severity', sortable: true, accessor: (v) => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(v.severity), render: (v) => <SevPill s={v.severity} /> },
            { key: 'pkg', header: 'Package', sortable: true, ellipsis: true, width: 160, mono: true },
            { key: 'fixedVersion', header: 'Fixed in', mono: true, render: (v) => v.fixedVersion || <em className="sec-dim">—</em> },
            { key: 'installedVersion', header: 'Installed', ellipsis: true, width: 120, mono: true },
            { key: 'title', header: 'Title', ellipsis: true, width: 260, render: (v) => v.title || '' },
          ]}
          rows={shown}
          rowKey={(v) => `${v.id}|${v.pkg}|${v.installedVersion}`}
          rowName={(v) => v.id}
          emptyState={<EmptyState icon="shieldCheck" size="sm" title={sevFilter ? `No ${sevFilter.toLowerCase()} vulnerabilities` : 'No vulnerabilities'} />}
          initialSort={{ key: 'severity', dir: 'asc' }}
          stickyHeader={false}
        />
      </div>
    </>
  );
}

function ChecksDetail({ d, onNavigate }) {
  useThemeTick();
  const [sevFilter, setSevFilter] = useState(null);
  const summary = d.summary || {};
  const navType = KIND_TYPE[d.kind];
  const toggleSev = (k) => setSevFilter((f) => (f === k ? null : k));
  const checks = d.checks || [];
  const shown = sevFilter ? checks.filter((c) => c.severity === sevFilter) : checks;
  const canNav = !!onNavigate;
  return (
    <>
      <h3 className="sec-drawer-section">Properties</h3>
      {d.createdAt && <Prop k="Created">{formatAgeLong(d.createdAt)}</Prop>}
      <Prop k="Name"><span className="sec-strong">{d.name}</span></Prop>
      <Prop k="Namespace">{d.namespace && canNav ? <LinkButton onClick={() => navToNamespace(onNavigate, d.namespace)}>{d.namespace}</LinkButton> : (d.namespace || '—')}</Prop>
      {d.labels ? <Prop k="Labels">{d.labels} Labels</Prop> : null}
      <Prop k="Controlled By">
        {d.kind}{' '}
        {navType && canNav ? <LinkButton onClick={() => navToResource(onNavigate, { type: navType, namespace: d.namespace, name: d.name })}>{d.name}</LinkButton> : d.name}
      </Prop>
      <Prop k="Status">Scanned</Prop>

      <h3 className="sec-drawer-section">Vulnerabilities</h3>
      <div className="sec-drawer-donut">
        <Donut segments={sevSegments(summary)} size={120} thickness={15} ariaLabel="Checks by severity" onSegmentClick={toggleSev} activeKey={sevFilter} />
      </div>
      <SevFilter summary={summary} active={sevFilter} onToggle={toggleSev} onClear={() => setSevFilter(null)} what="checks" />
      <Prop k="Severity"><SevPill s={worstSeverity(summary)} /></Prop>
      {d.scannedAt && <Prop k="Scanned">{formatAgeLong(d.scannedAt)}</Prop>}
      {d.scanner && <Prop k="Scan Result Source">{d.scanner}</Prop>}

      <h3 className="sec-drawer-section">Checks ({shown.length}{sevFilter ? ` of ${checks.length}` : ''})</h3>
      <ul className="sec-checks" aria-label="Checks">
        {withKeys(shown, (c) => `${c.id}|${c.title || ''}`).map(({ key, item: c }) => (
          <li className="sec-checkitem" key={key}>
            <SevPill s={c.severity} />
            <div className="sec-check-main">
              <div className="sec-check-title">{c.title || c.id} <code>{c.id}</code></div>
              {c.message && <div className="sec-check-msg">{c.message}</div>}
              {c.remediation && <div className="sec-check-fix"><strong>Fix:</strong> {c.remediation}</div>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export { FindingDrawer };
