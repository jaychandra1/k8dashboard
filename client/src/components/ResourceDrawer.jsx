import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import MetricsChart from './MetricsChart';
import ServicePortForward from './ServicePortForward';
import Button from './ui/Button';
import Badge, { StatusDot } from './ui/Badge';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import useClickOutside from '../hooks/useClickOutside';
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';
import { byKey, byApiKind, kindIcon } from '../lib/kinds';
import { statusTone } from '../lib/status';
import { formatAge, fmtCpu, fmtMem, fmtMemMi, decodeB64, cpuToMillicores, parseQuantity } from '../lib/format';
import {announce, afterPaint } from '../lib/a11y';
import { XLink, nsLink, nodeLink, resourceLink } from './resources/links';

// Sum a resource across containers only if every container specifies it
const sumRes = (containers, kind, res, parse) => {
  let total = 0; let count = 0;
  containers.forEach((c) => {
    const v = c.resources?.[kind]?.[res];
    if (v != null) { const n = parse(v); if (!Number.isNaN(n)) { total += n; count += 1; } }
  });
  return count === containers.length && count > 0 ? total : null;
};

// legacy tint classes on the title icon (kept for the visual look)
const TONE_CLASS = { ok: 'running', warn: 'pending', bad: 'failed' };

const MASK = '••••••••••••';

function Row({ label, children }) {
  if (children == null || children === '' || children === '-') return null;
  return (
    <div className="drawer-row">
      <span className="drawer-row-label">{label}</span>
      <span className="drawer-row-value">{children}</span>
    </div>
  );
}

function Chips({ obj, max }) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  const shown = max ? entries.slice(0, max) : entries;
  return (
    <div className="drawer-chips">
      {shown.map(([k, v]) => <span key={k} className="drawer-chip">{k}{v ? `: ${v}` : ''}</span>)}
      {max && entries.length > max && <span className="drawer-chip muted">+{entries.length - max} more</span>}
    </div>
  );
}

// Annotations often hold huge blobs (e.g. last-applied-configuration). Render
// each as a readable key → value pair, pretty-printing JSON and collapsing long
// values behind a toggle so the panel stays scannable.
function AnnotationItem({ name, value }) {
  const [open, setOpen] = useState(false);
  const raw = value == null ? '' : String(value);
  const trimmed = raw.trim();
  let pretty = null;
  const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (looksJson) { try { pretty = JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* not valid JSON */ } }
  const display = pretty ?? raw;
  const collapsible = pretty != null || display.length > 100 || display.includes('\n');
  return (
    <div className="anno-item">
      <div className="anno-key" title={name}>{name}</div>
      {collapsible ? (
        <div className="anno-value">
          <button type="button" className="anno-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} strokeWidth={2.4} />
            {open ? 'Hide' : (pretty != null ? 'Show JSON' : 'Show value')}
            <span className="anno-size">{pretty != null ? 'JSON · ' : ''}{display.length.toLocaleString()} chars</span>
          </button>
          {open && <pre className="anno-pre">{display}</pre>}
        </div>
      ) : (
        <div className="anno-value anno-inline">{raw}</div>
      )}
    </div>
  );
}

function Annotations({ obj }) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  // Put the noisy last-applied-configuration last; it's rarely what you want.
  entries.sort((a, b) => (a[0].includes('last-applied-configuration') ? 1 : 0) - (b[0].includes('last-applied-configuration') ? 1 : 0));
  return (
    <div className="drawer-annos">
      {entries.map(([k, v]) => <AnnotationItem key={k} name={k} value={v} />)}
    </div>
  );
}

/** One ConfigMap / Secret entry. Secret values are never rendered until revealed. */
function DataEntry({ name, value, secret, revealed, onToggleReveal }) {
  const copy = async () => {
    try { await navigator.clipboard?.writeText(String(value)); announce(`Copied ${name}`); } catch { announce('Copy failed', 'assertive'); }
  };
  return (
    <div className="data-item">
      <div className="data-key">
        <span>{name}</span>
        <span className="data-key-actions">
          {secret && (
            <button type="button" className="reveal-btn" aria-pressed={revealed} aria-label={`${revealed ? 'Hide' : 'Reveal'} value of ${name}`} onClick={onToggleReveal}>
              <Icon name={revealed ? 'eyeOff' : 'eye'} size={13} />
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          )}
          <Button variant="ghost" size="sm" iconOnly icon="copy" ariaLabel={`Copy value of ${name}`} className="data-copy" onClick={copy} />
        </span>
      </div>
      <pre className="data-value">{secret && !revealed ? MASK : String(value)}</pre>
    </div>
  );
}

export default function ResourceDrawer({
  resource,
  resourceType,
  onClose,
  onOpenLogs,
  onOpenTerminal,
  onOpenYaml,
  onDelete,
  onScale,
  onRestart,
  onNavigate,
  refreshSignal = 0,
  // legacy props
  namespace,
  onOpenTab,
  onAction,
  canScale,
  canRestart,
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const drawerRef = useRef(null);
  const headingRef = useRef(null);
  const opener = useRef(null);
  const close = useCallback(() => onClose?.(), [onClose]);
  useClickOutside(drawerRef, close);

  const name = resource?.name;
  const ns = resource?.namespace || (namespace && namespace !== 'all' ? namespace : '');
  const apiKind = byKey[resourceType]?.apiKind || resource?.kind || 'Pod';
  const isPodKind = apiKind === 'Pod';

  // Focus the heading whenever a (new) resource opens; restore focus to the
  // opener (the table row) when the panel closes. The component stays mounted
  // with `resource == null` between openings, so key this on the selection —
  // an empty dependency list would only ever fire once, before any heading exists.
  const isOpen = !!resource;
  useEffect(() => {
    if (!isOpen) return undefined;
    const drawerEl = drawerRef.current;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    // Switching between rows keeps the original opener; only record it when
    // focus is currently outside the panel.
    if (!drawerEl || !active || !drawerEl.contains(active)) opener.current = active;
    const cancelFocus = afterPaint(() => headingRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelFocus();
      // Restore only when focus is still inside the panel (i.e. the panel is
      // going away, not the user having moved on).
      const el = opener.current;
      const now = document.activeElement;
      // By the time a passive cleanup runs the panel's DOM is already gone, so
      // a focused element inside it has collapsed to <body>; treat that as
      // "focus was inside" too. A focus that moved elsewhere is left alone.
      const inside = !now || now === document.body || (drawerEl && drawerEl.contains(now));
      if (inside && el && typeof el.focus === 'function' && document.contains(el)) { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
    };
  }, [isOpen, name, ns]);

  // Escape closes the panel (unless a modal / menu on top owns the key).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.ui-modal-backdrop, [role="menu"], [role="tooltip"]')) return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // ---- detail ----
  const { data: obj, error, loading, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'resource', ns || '-', apiKind, name), { signal }),
    { deps: [ns, apiKind, name, refreshSignal], enabled: !!name, dedupeKey: `resource:${ns}/${apiKind}/${name}` },
  );

  // ---- live metrics (pods) ----
  const [cpuHist, setCpuHist] = useState([]);
  const [memHist, setMemHist] = useState([]);
  useEffect(() => { setCpuHist([]); setMemHist([]); }, [ns, name]);
  const { data: metricsNow, error: metricsError } = useRequest(
    ({ signal }) => getJson(p('api', 'metrics', 'pod', ns, name), { signal }),
    {
      deps: [ns, name],
      enabled: isPodKind && !!name && !!ns,
      pollMs: 3000,
      onSuccess: (m) => {
        if (!m || m.available === false) return;
        setCpuHist((h) => [...h, m.cpuMilli].slice(-40));
        setMemHist((h) => [...h, m.memBytes].slice(-40));
      },
    },
  );
  const metricsAvail = !metricsError && metricsNow?.available !== false;

  // ---- secrets ----
  const [revealed, setRevealed] = useState(() => new Set());
  useEffect(() => { setRevealed(new Set()); }, [ns, name]);
  const toggleReveal = (key) => setRevealed((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  if (!resource) return null;

  const meta = obj?.metadata || {};
  const spec = obj?.spec || {};
  const status = obj?.status || {};
  const kind = obj?.kind || apiKind;
  const isPod = kind === 'Pod';
  const isSecret = kind === 'Secret';
  const isConfigMap = kind === 'ConfigMap';

  // Data key/values: ConfigMap is plain; Secret is base64 → decoded in memory but
  // only rendered into the DOM once its key is revealed (see <DataEntry>).
  const dataEntries = (isSecret || isConfigMap)
    ? [
      ...Object.entries(obj?.data || {}).map(([k, v]) => [k, isSecret ? decodeB64(v) : v]),
      ...Object.entries(obj?.binaryData || {}).map(([k]) => [k, '<binary data>']),
      ...Object.entries(obj?.stringData || {}).map(([k, v]) => [k, v]),
    ]
    : [];

  const conditions = (status.conditions || []).filter((c) => c.status === 'True').map((c) => c.type);
  const owner = (meta.ownerReferences || [])[0];
  const ownerType = owner ? byApiKind[owner.kind] : null;
  const containers = spec.containers || [];

  // CPU/Memory thresholds: prefer limits, fall back to requests
  const cpuLimitVal = sumRes(containers, 'limits', 'cpu', cpuToMillicores);
  const cpuReqVal = sumRes(containers, 'requests', 'cpu', cpuToMillicores);
  const cpuThreshold = cpuLimitVal ?? cpuReqVal; // millicores
  const cpuThreshKind = cpuLimitVal != null ? 'limit' : 'request';
  const memLimitVal = sumRes(containers, 'limits', 'memory', parseQuantity);
  const memReqVal = sumRes(containers, 'requests', 'memory', parseQuantity);
  const memThreshold = memLimitVal ?? memReqVal; // bytes
  const memThreshKind = memLimitVal != null ? 'limit' : 'request';

  const secretNames = [];
  (spec.volumes || []).forEach((v) => { if (v.secret?.secretName) secretNames.push(v.secret.secretName); });
  (spec.imagePullSecrets || []).forEach((s) => s.name && secretNames.push(s.name));

  const displayStatus = status.phase || resource.status || '';
  const tone = statusTone(kind, displayStatus);

  // Action availability: new callbacks first, legacy onOpenTab/onAction as fallback.
  const doLogs = onOpenLogs ? () => onOpenLogs(resource) : (onOpenTab ? () => onOpenTab('logs') : null);
  const doTerminal = onOpenTerminal ? () => onOpenTerminal(resource) : (onOpenTab ? () => onOpenTab('terminal') : null);
  const doYaml = onOpenYaml ? () => onOpenYaml(resource) : (onOpenTab ? () => onOpenTab('configuration') : null);
  const doScale = onScale ? () => onScale(resource) : (canScale && onAction ? () => onAction('scale') : null);
  const doRestart = onRestart ? () => onRestart(resource) : (canRestart && onAction ? () => onAction('restart') : null);
  const doDelete = onDelete ? () => onDelete(resource) : (onAction ? () => onAction('delete') : null);

  return (
    <aside
      className="resource-drawer"
      ref={drawerRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <div className="drawer-header">
        <div className="drawer-title">
          <div className={`drawer-title-icon ${TONE_CLASS[tone] || 'blue'}`} aria-hidden="true">
            <Icon name={kindIcon(kind)} size={18} />
          </div>
          <div className="drawer-title-text">
            <span className="drawer-kind">{kind}</span>
            <h2 id={titleId} ref={headingRef} tabIndex={-1} className="drawer-name" title={name}>{name}</h2>
          </div>
        </div>
        <div className="drawer-actions">
          {isPod && doLogs && <Button variant="ghost" iconOnly icon="logs" ariaLabel={`Logs for ${name}`} className="drawer-action-btn" onClick={doLogs} />}
          {isPod && doTerminal && <Button variant="ghost" iconOnly icon="terminal" ariaLabel={`Open terminal in ${name}`} className="drawer-action-btn" onClick={doTerminal} />}
          {doYaml && <Button variant="ghost" iconOnly icon="configuration" ariaLabel={`Edit YAML of ${name}`} className="drawer-action-btn" onClick={doYaml} />}
          {doScale && <Button variant="ghost" iconOnly icon="scale" ariaLabel={`Scale ${name}`} className="drawer-action-btn" onClick={doScale} />}
          {doRestart && <Button variant="ghost" iconOnly icon="refresh" ariaLabel={`Rollout restart ${name}`} className="drawer-action-btn" onClick={doRestart} />}
          {doDelete && <Button variant="ghost" iconOnly icon="delete" ariaLabel={`Delete ${name}`} className="drawer-action-btn danger" onClick={doDelete} />}
          <Button variant="ghost" iconOnly icon="close" iconSize={17} ariaLabel="Close details" className="drawer-action-btn" onClick={close} />
        </div>
      </div>

      <div className="drawer-body">
        {isPodKind && (
          <section className="drawer-section" aria-label="Resource usage">
            <div className="drawer-section-title">Resource Usage</div>
            {!metricsAvail ? (
              <div className="drawer-dim">Metrics not available</div>
            ) : (
              <div className="metric-charts">
                <MetricsChart id={`${uid}-cpu`} label="CPU" data={cpuHist} limit={cpuThreshold} thresholdLabel={cpuThreshKind} format={fmtCpu} tone="info" />
                <MetricsChart id={`${uid}-mem`} label="Memory" data={memHist.map((b) => b / 1024 / 1024)} limit={memThreshold != null ? memThreshold / 1024 / 1024 : null} thresholdLabel={memThreshKind} format={fmtMemMi} tone="purple" />
              </div>
            )}
          </section>
        )}

        {loading && !obj && <div className="drawer-section"><Skeleton rows={6} cols={2} label="Loading details" /></div>}
        {error && !obj && <ErrorState compact error={error} title="Couldn't load details" onRetry={refetch} />}

        {obj && (
          <>
            <section className="drawer-section" aria-label="Metadata">
              <Row label="Created">
                {formatAge(meta.creationTimestamp)} ago
                {meta.creationTimestamp && <span className="drawer-dim"> ({new Date(meta.creationTimestamp).toLocaleString()})</span>}
              </Row>
              <Row label="Name">{meta.name}</Row>
              <Row label="Namespace">
                {meta.namespace ? <XLink link={nsLink(meta.namespace)} onNavigate={onNavigate}>{meta.namespace}</XLink> : null}
              </Row>
              <Row label="Labels"><Chips obj={meta.labels} max={12} /></Row>
              {meta.annotations && Object.keys(meta.annotations).length > 0 && (
                <div className="drawer-annos-block">
                  <span className="drawer-row-label">Annotations</span>
                  <Annotations obj={meta.annotations} />
                </div>
              )}
            </section>

            <section className="drawer-section" aria-label="Status">
              <Row label="Status">
                {displayStatus ? <Badge status={displayStatus} kind={kind} /> : '—'}
              </Row>
              {isPod && (
                <>
                  <Row label="Node">
                    {spec.nodeName ? <XLink link={nodeLink(spec.nodeName)} onNavigate={onNavigate}>{spec.nodeName}</XLink> : null}
                  </Row>
                  <Row label="Pod IP">{status.podIP}</Row>
                  <Row label="Priority Class">{spec.priorityClassName || '—'}</Row>
                  <Row label="QoS Class">{status.qosClass}</Row>
                  <Row label="Service Account">{spec.serviceAccountName || spec.serviceAccount}</Row>
                  <Row label="Conditions">
                    <span className="drawer-chips">
                      {conditions.map((c) => <span key={c} className="drawer-chip cond">{c}</span>)}
                    </span>
                  </Row>
                  {spec.tolerations?.length ? <Row label="Tolerations">{spec.tolerations.length}</Row> : null}
                  {secretNames.length ? (
                    <Row label="Secrets">
                      <span className="drawer-chips">
                        {[...new Set(secretNames)].map((s) => (
                          <XLink key={s} className="drawer-chip xlink" link={resourceLink('secret', meta.namespace, s)} onNavigate={onNavigate}>{s}</XLink>
                        ))}
                      </span>
                    </Row>
                  ) : null}
                </>
              )}
              {owner && (
                <Row label="Controlled By">
                  {ownerType ? (
                    <XLink link={resourceLink(ownerType, meta.namespace, owner.name)} onNavigate={onNavigate}>{owner.kind}/{owner.name}</XLink>
                  ) : (
                    <span>{owner.kind}/{owner.name}</span>
                  )}
                </Row>
              )}
            </section>

            {/* ConfigMap / Secret data */}
            {(isConfigMap || isSecret) && (
              <section className="drawer-section" aria-label="Data">
                <div className="drawer-section-title data-title">
                  <span>Data ({dataEntries.length})</span>
                  {isSecret && dataEntries.length > 0 && revealed.size > 0 && (
                    <button type="button" className="reveal-btn" onClick={() => setRevealed(new Set())}>
                      <Icon name="eyeOff" size={13} /> Hide all
                    </button>
                  )}
                </div>
                {dataEntries.length === 0 ? (
                  <div className="drawer-dim">No data</div>
                ) : (
                  dataEntries.map(([key, value]) => (
                    <DataEntry
                      key={key}
                      name={key}
                      value={value}
                      secret={isSecret && value !== '<binary data>'}
                      revealed={!isSecret || revealed.has(key)}
                      onToggleReveal={() => toggleReveal(key)}
                    />
                  ))
                )}
              </section>
            )}

            {/* Workload spec */}
            {(kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet' || kind === 'ReplicaSet') && (
              <section className="drawer-section" aria-label="Replicas">
                <div className="drawer-section-title">Replicas</div>
                <Row label="Desired">{spec.replicas != null ? spec.replicas : '—'}</Row>
                <Row label="Ready">{status.readyReplicas || 0}</Row>
                <Row label="Available">{status.availableReplicas || 0}</Row>
                <Row label="Updated">{status.updatedReplicas || 0}</Row>
                <Row label="Strategy">{spec.strategy?.type || spec.updateStrategy?.type}</Row>
                <Row label="Selector"><Chips obj={spec.selector?.matchLabels} max={8} /></Row>
              </section>
            )}

            {/* Service spec */}
            {kind === 'Service' && (
              <section className="drawer-section" aria-label="Networking">
                <div className="drawer-section-title">Networking</div>
                <Row label="Type">{spec.type}</Row>
                <Row label="Cluster IP">{spec.clusterIP}</Row>
                <Row label="Session Affinity">{spec.sessionAffinity}</Row>
                <Row label="Selector"><Chips obj={spec.selector} max={8} /></Row>
                <Row label="Ports">
                  <span className="drawer-chips">
                    {(spec.ports || []).map((pt) => (
                      <span key={`${pt.name || ''}:${pt.port}:${pt.protocol || 'TCP'}`} className="drawer-chip">{pt.port}{pt.targetPort ? `→${pt.targetPort}` : ''}/{pt.protocol || 'TCP'}</span>
                    ))}
                  </span>
                </Row>
              </section>
            )}

            {/* Port forwarding (services only) */}
            {kind === 'Service' && (
              <ServicePortForward namespace={meta.namespace} name={meta.name} ports={spec.ports || []} />
            )}

            {/* PersistentVolume storage — link out to its StorageClass and bound PVC */}
            {kind === 'PersistentVolume' && (
              <section className="drawer-section" aria-label="Storage">
                <div className="drawer-section-title">Storage</div>
                <Row label="Capacity">{spec.capacity?.storage}</Row>
                <Row label="Access Modes">{(spec.accessModes || []).join(', ')}</Row>
                <Row label="Reclaim Policy">{spec.persistentVolumeReclaimPolicy}</Row>
                <Row label="Volume Mode">{spec.volumeMode}</Row>
                <Row label="Storage Class">
                  {spec.storageClassName ? <XLink link={resourceLink('storageClass', '', spec.storageClassName)} onNavigate={onNavigate}>{spec.storageClassName}</XLink> : '—'}
                </Row>
                <Row label="Claim">
                  {spec.claimRef?.name ? (
                    <XLink link={resourceLink('persistentVolumeClaim', spec.claimRef.namespace, spec.claimRef.name)} onNavigate={onNavigate}>
                      {spec.claimRef.namespace ? `${spec.claimRef.namespace}/` : ''}{spec.claimRef.name}
                    </XLink>
                  ) : '—'}
                </Row>
              </section>
            )}

            {/* PersistentVolumeClaim storage — link out to its StorageClass and bound PV */}
            {kind === 'PersistentVolumeClaim' && (
              <section className="drawer-section" aria-label="Storage">
                <div className="drawer-section-title">Storage</div>
                <Row label="Capacity">{status.capacity?.storage || spec.resources?.requests?.storage}</Row>
                <Row label="Access Modes">{(spec.accessModes || []).join(', ')}</Row>
                <Row label="Volume Mode">{spec.volumeMode}</Row>
                <Row label="Storage Class">
                  {spec.storageClassName ? <XLink link={resourceLink('storageClass', '', spec.storageClassName)} onNavigate={onNavigate}>{spec.storageClassName}</XLink> : '—'}
                </Row>
                <Row label="Volume">
                  {spec.volumeName ? <XLink link={resourceLink('persistentVolume', '', spec.volumeName)} onNavigate={onNavigate}>{spec.volumeName}</XLink> : '—'}
                </Row>
              </section>
            )}

            {/* Containers */}
            {containers.length > 0 && (
              <section className="drawer-section" aria-label="Containers">
                <div className="drawer-section-title">Containers ({containers.length})</div>
                {containers.map((c) => {
                  const cs = (status.containerStatuses || []).find((s) => s.name === c.name);
                  const ready = cs?.ready;
                  const cTone = ready ? 'ok' : (cs ? 'bad' : 'warn');
                  const cLabel = ready ? 'ready' : (cs ? 'not ready' : 'pending');
                  const cm = metricsNow?.containers?.find((m) => m.name === c.name);
                  return (
                    <div key={c.name} className="drawer-container">
                      <div className="drawer-container-head">
                        <StatusDot tone={cTone} label={`${c.name}: ${cLabel}`} />
                        <span className="drawer-container-name">{c.name}</span>
                        {cs && <span className="drawer-dim">restarts: {cs.restartCount}</span>}
                      </div>
                      {cm && (
                        <Row label="Usage">
                          <span className="metric-cpu">{fmtCpu(cm.cpuMilli)} CPU</span>
                          {' · '}
                          <span className="metric-mem">{fmtMem(cm.memBytes)} Mem</span>
                        </Row>
                      )}
                      <Row label="Image">{c.image}</Row>
                      {c.ports?.length ? (
                        <Row label="Ports">
                          <span className="drawer-chips">
                            {c.ports.map((pt) => <span key={`${pt.name || ''}:${pt.containerPort}:${pt.protocol || 'TCP'}`} className="drawer-chip">{pt.containerPort}/{pt.protocol || 'TCP'}</span>)}
                          </span>
                        </Row>
                      ) : null}
                      {c.resources?.requests && (
                        <Row label="Requests">{`${c.resources.requests.cpu || '—'} CPU · ${c.resources.requests.memory || '—'} Mem`}</Row>
                      )}
                      {c.resources?.limits && (
                        <Row label="Limits">{`${c.resources.limits.cpu || '—'} CPU · ${c.resources.limits.memory || '—'} Mem`}</Row>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
