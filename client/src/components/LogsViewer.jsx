import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Icon from './Icons';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import { getJson, p, errorMessage } from '../lib/api';

// Per-container accent tone (used for the [container] prefix) — colours come from App.css.
const CONTAINER_TONES = ['info', 'ok', 'purple', 'cyan', 'warn', 'bad', 'accent', 'muted'];
const toneFor = (name, list) => CONTAINER_TONES[Math.max(0, list.indexOf(name)) % CONTAINER_TONES.length];

export const TAIL_OPTIONS = [200, 1000, 5000, 20000];
const FOLLOW_MS = 4000;
const FALLBACK_MAX = 500; // lines rendered when the scroll box can't be measured
// Workload mode: "All pods" reads at most this many replicas (kubectl's
// --max-log-requests default is 5 when following; 10 keeps follow polling sane)
// and keeps at most this many merged lines.
export const MAX_LOG_PODS = 10;
const MAX_MERGED_LINES = 50000;

// Local ISO timestamp with offset, e.g. 2026-09-08T17:33:29.058+05:30.
const fmtTs = (d) => {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
};

// Light log-level colouring when not searching.
const LEVEL_RX = /\b(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|PANIC)\b/g;
const LEVEL_CLASS = { ERROR: 'err', ERR: 'err', FATAL: 'err', PANIC: 'err', WARN: 'warn', WARNING: 'warn', INFO: 'info', DEBUG: 'dbg', TRACE: 'dbg' };
function colorLevels(msg) {
  const segs = []; let last = 0; let m; LEVEL_RX.lastIndex = 0;
  while ((m = LEVEL_RX.exec(msg)) !== null) {
    if (m.index > last) segs.push({ t: msg.slice(last, m.index) });
    segs.push({ t: m[0], cls: LEVEL_CLASS[m[0].toUpperCase()] });
    last = m.index + m[0].length;
  }
  if (last < msg.length) segs.push({ t: msg.slice(last) });
  return segs.map((s, k) => (s.cls ? <span key={`${k}:${s.t}`} className={`logs-lvl ${s.cls}`}>{s.t}</span> : <span key={`${k}:${s.t.length}`}>{s.t}</span>));
}

function parseLog(text, cname) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (!raw) continue;
    const sp = raw.indexOf(' ');
    let ts = null; let msg = raw;
    if (sp > 0) {
      const cand = raw.slice(0, sp);
      if (/^\d{4}-\d\d-\d\dT/.test(cand)) { const d = new Date(cand); if (!Number.isNaN(d.getTime())) { ts = d; msg = raw.slice(sp + 1); } }
    }
    out.push({ ts, msg, container: cname });
  }
  return out;
}

/**
 * Pod logs with search, follow mode and virtualised rendering.
 *   <LogsViewer namespace pod containers={['app','sidecar']} initialContainer onClose />
 * Workload mode (e.g. a Deployment): pass the workload and its pods. A Pod
 * picker offers "All pods" — merged chronologically, each line prefixed with
 * its pod — or a single replica.
 *   <LogsViewer namespace workload={{ kind: 'Deployment', name }} pods={[{ name, containerNames, status }]} totalPods onClose />
 */
export default function LogsViewer({ namespace, pod, containers, initialContainer, onClose, resource, searchQuery = '', onSearchChange, workload, pods, totalPods }) {
  const uid = useId();
  const podName = pod || resource?.name;
  const ns = namespace || resource?.namespace;
  const singleContainers = useMemo(() => (containers && containers.length ? containers : (resource?.containerNames || [])), [containers, resource]);

  // Workload mode: the workload's pods and the picked replica ('' → all pods).
  const podList = useMemo(() => (Array.isArray(pods) && pods.length ? pods : null), [pods]);
  const [podSel, setPodSel] = useState('');
  // The picked replica went away (rollout, scale-down) → back to all pods.
  useEffect(() => { if (podSel && podList && !podList.some((x) => x.name === podSel)) setPodSel(''); }, [podSel, podList]);

  // Log sources: the pod(s) being read and their containers. A re-polled pod
  // list with the same pods yields the same `sourcesKey`, so nothing refetches.
  const sources = useMemo(() => {
    if (!podList) return podName ? [{ name: podName, containerNames: singleContainers }] : [];
    const chosen = podSel ? podList.filter((x) => x.name === podSel) : podList.slice(0, MAX_LOG_PODS);
    return chosen.map((x) => ({ name: x.name, containerNames: x.containerNames || [] }));
  }, [podList, podSel, podName, singleContainers]);
  const sourcesKey = sources.map((s) => `${s.name}:${s.containerNames.join('+')}`).join(',');
  const containerNames = useMemo(() => [...new Set(sources.flatMap((s) => s.containerNames))], [sources]);
  const multiPod = sources.length > 1;
  const title = workload?.name || podName;
  const poolSize = Math.max(totalPods || 0, podList?.length || 0);
  // "All pods" prefixes each line with its pod, minus the workload-name
  // prefix (web-7c8f9d6b5-ck002 → 7c8f9d6b5-ck002).
  const workloadName = workload?.name;
  const shortPod = useCallback((name) => (workloadName && name.startsWith(`${workloadName}-`) ? name.slice(workloadName.length + 1) : name), [workloadName]);

  const [container, setContainer] = useState(initialContainer || ''); // '' → all containers
  const [tail, setTail] = useState(1000);
  const [follow, setFollow] = useState(false);
  const [showTs, setShowTs] = useState(false);
  const [showNames, setShowNames] = useState(multiPod || containerNames.length > 1);
  const [wrap, setWrap] = useState(true);
  const [q, setQ] = useState(searchQuery || '');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [active, setActive] = useState(0);
  const bodyRef = useRef(null);

  // Reset the container choice when the pod / requested container changes.
  useEffect(() => { setContainer(initialContainer || ''); }, [podName, initialContainer]);
  // A container the newly picked replica doesn't have → all containers.
  useEffect(() => { if (container && containerNames.length && !containerNames.includes(container)) setContainer(''); }, [container, containerNames]);
  useEffect(() => { setShowNames(multiPod || containerNames.length > 1); }, [multiPod, containerNames.length]);

  // Line keys: `${generation}-${index}`; the generation bumps whenever the log
  // source changes so React never reuses a row across pods / containers.
  const gen = useRef(0);
  useEffect(() => { gen.current += 1; }, [ns, sourcesKey, container]);

  const { data, error, loading, refetching, refetch } = useRequest(
    async ({ signal }) => {
      // One request per (pod, container); the line prefix names the source.
      const multiContainer = containerNames.length > 1;
      const targets = sources.flatMap((s) => {
        const cs = container
          ? (s.containerNames.length && !s.containerNames.includes(container) ? [] : [container])
          : (s.containerNames.length ? s.containerNames : ['']);
        return cs.map((c) => ({
          pod: s.name,
          c,
          label: multiPod ? (multiContainer && c ? `${shortPod(s.name)}/${c}` : shortPod(s.name)) : (c || containerNames[0] || ''),
        }));
      });
      const settled = await Promise.allSettled(targets.map((t) => getJson(p('api', 'logs', ns, t.pod), { signal, params: { container: t.c || undefined, timestamps: true, tail } })));
      const failedAt = settled.map((r, i) => (r.status === 'rejected' ? i : -1)).filter((i) => i >= 0);
      // Nothing readable (or the request was aborted) → surface the error.
      if (settled.length && failedAt.length === settled.length) throw settled[0].reason;
      const merged = settled
        .flatMap((r, i) => (r.status === 'fulfilled' ? parseLog(r.value?.logs || '', targets[i].label) : []))
        .map((l, i) => ({ ...l, _i: i }));
      // Chronological merge across pods / containers when timestamps are present (stable otherwise).
      merged.sort((a, b) => (a.ts && b.ts ? a.ts - b.ts || a._i - b._i : a._i - b._i));
      return {
        lines: merged.length > MAX_MERGED_LINES ? merged.slice(-MAX_MERGED_LINES) : merged,
        labels: [...new Set(targets.map((t) => t.label))],
        unavailable: failedAt.map((i) => ({ label: targets[i].label || targets[i].pod, message: errorMessage(settled[i].reason, 'unavailable') })),
        fetchedAt: Date.now(),
        gen: gen.current,
      };
    },
    {
      deps: [ns, sourcesKey, container, tail],
      enabled: !!ns && sources.length > 0,
      pollMs: follow ? FOLLOW_MS : 0,
      dedupeKey: `logs:${ns}/${sourcesKey}/${container || '*'}/${tail}`,
    },
  );
  const lines = useMemo(() => data?.lines || [], [data]);
  const toneList = data?.labels || containerNames;
  const unavailable = data?.unavailable || [];
  const lineGen = data?.gen ?? 0;

  // ---- search ----
  const rx = useMemo(() => {
    if (!q) return null;
    try {
      const src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch { return null; }
  }, [q, regex, caseSensitive]);
  const regexInvalid = !!q && regex && !rx;

  // Flat list of match line-indexes (one entry per occurrence) + first-global-index per line.
  const { matchLines, lineBase } = useMemo(() => {
    const ml = []; const base = new Map();
    if (rx) lines.forEach((l, i) => {
      rx.lastIndex = 0; let m; let had = false;
      while ((m = rx.exec(l.msg)) !== null) {
        if (!had) { base.set(i, ml.length); had = true; }
        ml.push(i);
        if (m.index === rx.lastIndex) rx.lastIndex += 1;
      }
    });
    return { matchLines: ml, lineBase: base };
  }, [rx, lines]);

  useEffect(() => { setActive(0); }, [q, regex, caseSensitive]);

  // ---- virtualisation ----
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => 20,
    overscan: 20,
    initialRect: { width: 0, height: 480 },
    getItemKey: (i) => `${lineGen}-${i}`,
  });
  const virtualItems = virtualizer.getVirtualItems();
  // A zero-height scroll box (hidden tab pane, jsdom) yields no virtual items;
  // fall back to a bounded plain render so the log is never blank.
  const unmeasured = virtualItems.length === 0 && lines.length > 0;
  const vItems = unmeasured ? lines.slice(0, FALLBACK_MAX).map((_, i) => ({ index: i, key: `${lineGen}-${i}` })) : virtualItems;
  const paddingTop = !unmeasured && vItems.length ? vItems[0].start : 0;
  const paddingBottom = !unmeasured && vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1].end : 0;

  // Follow the tail when not searching (and always while following).
  useEffect(() => {
    if (!lines.length) return;
    if (follow || !q) virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
  }, [lines, follow, q, virtualizer]);
  // Bring the active match into view.
  useEffect(() => {
    if (!matchLines.length) return;
    const li = matchLines[Math.min(active, matchLines.length - 1)];
    virtualizer.scrollToIndex(li, { align: 'center' });
  }, [active, matchLines, virtualizer]);

  const nav = (dir) => { if (matchLines.length) setActive((a) => (a + dir + matchLines.length) % matchLines.length); };
  const onSearch = (v) => { setQ(v); onSearchChange?.(v); };

  const renderMsg = useCallback((msg, lineIdx) => {
    if (!rx) return colorLevels(msg);
    const segs = []; let last = 0; let m; let occ = 0; const gBase = lineBase.get(lineIdx) ?? 0;
    rx.lastIndex = 0;
    while ((m = rx.exec(msg)) !== null) {
      if (m.index > last) segs.push({ t: msg.slice(last, m.index) });
      segs.push({ t: m[0], hl: true, active: gBase + occ === active });
      last = m.index + m[0].length; occ += 1;
      if (m.index === rx.lastIndex) rx.lastIndex += 1;
    }
    if (last < msg.length) segs.push({ t: msg.slice(last) });
    return segs.map((s, k) => (s.hl ? <mark key={`${k}:m`} className={`logs-hl${s.active ? ' active' : ''}`}>{s.t}</mark> : <span key={`${k}:t`}>{s.t}</span>));
  }, [rx, lineBase, active]);

  const handleDownload = () => {
    const text = lines.map((l) => `${l.ts ? `${fmtTs(l.ts)} ` : ''}${l.container ? `[${l.container}] ` : ''}${l.msg}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${podSel || title || 'pod'}${container ? `-${container}` : ''}.log`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const count = matchLines.length ? `${Math.min(active + 1, matchLines.length)} / ${matchLines.length}` : '0 / 0';
  const fetchedAt = data?.fetchedAt ? new Date(data.fetchedAt) : null;
  const containerSelectId = `${uid}-container`;
  const podSelectId = `${uid}-pod`;
  const tailSelectId = `${uid}-tail`;
  const searchId = `${uid}-search`;

  return (
    <div className="logs-viewer">
      <div className="logs-toolbar" role="toolbar" aria-label="Log controls">
        <button type="button" className="logs-icon-btn" onClick={refetch} aria-label="Reload logs" aria-busy={refetching || undefined}><Icon name="refresh" size={15} /></button>

        {podList && (
          <div className="logs-select pod">
            <Icon name="pod" size={13} aria-hidden="true" />
            <label htmlFor={podSelectId} className="sr-only">Pod</label>
            <select id={podSelectId} value={podSel} onChange={(e) => setPodSel(e.target.value)}>
              <option value="">All pods ({podList.length > MAX_LOG_PODS ? `first ${MAX_LOG_PODS} of ${podList.length}` : podList.length})</option>
              {podList.map((x) => <option key={x.name} value={x.name}>{x.name}{x.status && x.status !== 'Running' ? ` (${x.status})` : ''}</option>)}
            </select>
            <Icon name="chevronDown" size={13} className="logs-select-caret" aria-hidden="true" />
          </div>
        )}

        <div className="logs-select">
          <Icon name="box" size={13} aria-hidden="true" />
          <label htmlFor={containerSelectId} className="sr-only">Container</label>
          <select id={containerSelectId} value={container} onChange={(e) => setContainer(e.target.value)}>
            <option value="">All Containers</option>
            {containerNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Icon name="chevronDown" size={13} className="logs-select-caret" aria-hidden="true" />
        </div>

        <div className="logs-search" role="search">
          <Icon name="filter" size={13} className="logs-search-lead" aria-hidden="true" />
          <button type="button" className={`logs-search-toggle${caseSensitive ? ' on' : ''}`} onClick={() => setCaseSensitive((v) => !v)} aria-pressed={caseSensitive} aria-label="Match case">Aa</button>
          <button type="button" className={`logs-search-toggle mono${regex ? ' on' : ''}`} onClick={() => setRegex((v) => !v)} aria-pressed={regex} aria-label="Use regular expression">.*</button>
          <label htmlFor={searchId} className="sr-only">Search in logs</label>
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search in logs"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={regexInvalid ? 'true' : undefined}
            aria-describedby={`${uid}-count`}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nav(e.shiftKey ? -1 : 1); } }}
          />
          <span id={`${uid}-count`} className="logs-search-count" aria-live="polite">{regexInvalid ? 'invalid regex' : `${count}${q ? ' matches' : ''}`}</span>
          <button type="button" className="logs-icon-btn sm" onClick={() => nav(-1)} disabled={!matchLines.length} aria-label="Previous match"><Icon name="chevronUp" size={14} /></button>
          <button type="button" className="logs-icon-btn sm" onClick={() => nav(1)} disabled={!matchLines.length} aria-label="Next match"><Icon name="chevronDown" size={14} /></button>
        </div>

        <div className="logs-spacer" />

        <button type="button" className={`logs-icon-btn${follow ? ' on' : ''}`} onClick={() => setFollow((v) => !v)} aria-pressed={follow} aria-label="Follow logs (refresh every few seconds)"><Icon name="activity" size={15} /></button>
        <button type="button" className={`logs-icon-btn${showTs ? ' on' : ''}`} onClick={() => setShowTs((v) => !v)} aria-pressed={showTs} aria-label="Show timestamps"><Icon name="timer" size={15} /></button>
        <button type="button" className={`logs-icon-btn${showNames ? ' on' : ''}`} onClick={() => setShowNames((v) => !v)} aria-pressed={showNames} aria-label="Show container names"><Icon name="tag" size={15} /></button>
        <button type="button" className={`logs-icon-btn${wrap ? ' on' : ''}`} onClick={() => setWrap((v) => !v)} aria-pressed={wrap} aria-label="Wrap long lines"><Icon name="wrapText" size={15} /></button>
        <button type="button" className="logs-icon-btn" onClick={handleDownload} disabled={!lines.length} aria-label={`Download logs for ${title}`}><Icon name="download" size={15} /></button>
        <div className="logs-select tail">
          <label htmlFor={tailSelectId} className="sr-only">Lines to show</label>
          <select id={tailSelectId} value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAIL_OPTIONS.map((n) => <option key={n} value={n}>Last {n.toLocaleString()}</option>)}
          </select>
          <Icon name="chevronDown" size={13} className="logs-select-caret" aria-hidden="true" />
        </div>
        {onClose && (
          <button type="button" className="logs-icon-btn" onClick={onClose} aria-label={`Close logs for ${title}`}><Icon name="close" size={15} /></button>
        )}
      </div>

      <div className="logs-info">
        Displaying logs from Namespace: <b>{ns}</b>
        {podList
          ? <> for {workload?.kind || 'Workload'}: <b>{workload?.name}</b> · Pod: <b>{podSel || `all ${sources.length}${poolSize > sources.length ? ` of ${poolSize}` : ''}`}</b></>
          : <> for Pod: <b>{podName}</b></>}
        {container ? <> · Container: <b>{container}</b></> : null}
        {unavailable.length ? <> · <span className="logs-unavailable" title={unavailable.map((u) => `${u.label}: ${u.message}`).join('\n')}>{unavailable.length} {unavailable.length === 1 ? 'source' : 'sources'} unavailable</span></> : null}
        {fetchedAt ? <> · Logs from {fetchedAt.toLocaleString()}</> : null}
        {follow ? <> · <span className="logs-follow">following</span></> : null}
      </div>

      <div
        className={`logs-body${wrap ? ' wrap' : ''}`}
        ref={bodyRef}
        role="log"
        aria-label={`Logs for ${title}`}
        aria-live={follow ? 'polite' : 'off'}
        aria-busy={loading || refetching || undefined}
        tabIndex={0}
      >
        {loading && !lines.length && <div className="logs-center"><Skeleton block height={120} label="Loading logs" /></div>}
        {error && !lines.length && <div className="logs-center"><ErrorState compact error={error} title="Couldn't load logs" onRetry={refetch} busy={refetching} /></div>}
        {!loading && !error && lines.length === 0 && <div className="logs-center logs-empty">No logs to display</div>}
        {lines.length > 0 && (
          <div className="logs-lines" style={{ paddingTop, paddingBottom }}>
            {vItems.map((v) => {
              const l = lines[v.index];
              const i = v.index;
              return (
                <div className="logs-row" data-line={i} data-index={i} key={v.key} ref={wrap ? virtualizer.measureElement : undefined}>
                  {showTs && l.ts && <span className="logs-ts">{fmtTs(l.ts)}</span>}
                  {showNames && l.container && <span className="logs-cname" data-tone={toneFor(l.container, toneList)}>[{l.container}]</span>}
                  <span className="logs-msg">{renderMsg(l.msg, i)}</span>
                  <span className="logs-lineno" aria-hidden="true">{i + 1}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
