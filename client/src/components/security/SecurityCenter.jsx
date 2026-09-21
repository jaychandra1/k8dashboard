import { useEffect, useId, useState } from 'react';
import Icon from '../Icons';
import Loader from '../Loader';
import useRequest from '../../hooks/useRequest';
import { getJson, postJson, p, errorMessage } from '../../lib/api';
import ErrorState from '../ui/ErrorState';
import SearchBox from '../ui/SearchBox';
import { errorTitle } from '../shared/errors';
import { tablistKeys } from '../shared/tabs';
import VulnTable from './VulnTable';
import ChecksTable from './ChecksTable';
import ScanPanel, { OperatorNote } from './ScanPanel';
import FindingDrawer from './FindingDrawer';
import SetupState from './SetupState';

// Security Center — image CVEs, resource best-practice (config-audit) and RBAC
// risk, read from the Trivy Operator's report CRDs, or from the built-in Trivy
// scan when the operator isn't installed. Overview / Images / Resources / Roles.

const TABS = [['overview', 'Overview'], ['images', 'Images'], ['resources', 'Resources'], ['roles', 'Roles']];
const TAB_KEYS = TABS.map(([k]) => k);
const WHAT = { overview: 'vulnerability reports', images: 'vulnerability reports', resources: 'configuration audit reports', roles: 'RBAC assessment reports' };

export default function SecurityCenter({ view, onViewChange, refreshSignal = 0, namespaces = [], onNavigate }) {
  const id = useId();
  const [localTab, setLocalTab] = useState('overview');
  const tab = view && TAB_KEYS.includes(view) ? view : localTab;
  const setTab = (k) => { setLocalTab(k); onViewChange?.(k); };
  const [ns, setNs] = useState('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState(null); // { type: 'image' | 'checks', data }
  const [scanError, setScanError] = useState(null);
  const [starting, setStarting] = useState(false);

  const statusReq = useRequest(({ signal }) => getJson(p('api', 'security', 'status'), { signal }), { deps: [refreshSignal], dedupeKey: 'security:status' });
  const status = statusReq.data;
  const operatorMode = !!status?.installed;
  const scanMode = !!status && !operatorMode;
  const nsParam = ns !== 'all' ? ns : undefined;
  const vulnTab = tab === 'overview' || tab === 'images';

  // Operator mode: the report CRDs, per tab.
  const vulnReq = useRequest(
    ({ signal }) => getJson(p('api', 'security', 'vulnerabilities'), { signal, params: { namespace: nsParam } }),
    { enabled: operatorMode && vulnTab, deps: [ns, refreshSignal], dedupeKey: `security:vuln:${ns}` },
  );
  const configReq = useRequest(
    ({ signal }) => getJson(p('api', 'security', 'checks'), { signal, params: { namespace: nsParam, kind: 'config' } }),
    { enabled: operatorMode && tab === 'resources', deps: [ns, refreshSignal], dedupeKey: `security:config:${ns}` },
  );
  const rbacReq = useRequest(
    ({ signal }) => getJson(p('api', 'security', 'checks'), { signal, params: { namespace: nsParam, kind: 'rbac' } }),
    { enabled: operatorMode && tab === 'roles', deps: [ns, refreshSignal], dedupeKey: `security:rbac:${ns}` },
  );

  // Scan mode: trivy availability + the live / persisted scan. While a scan is
  // running the same request polls every 2 s (useRequest pauses it when the tab
  // is hidden); once `running` flips to false the poll stops.
  const [scanRunning, setScanRunning] = useState(false);
  const availReq = useRequest(({ signal }) => getJson(p('api', 'security', 'scan', 'status'), { signal }), { enabled: scanMode, deps: [refreshSignal], dedupeKey: 'security:scan:status' });
  const scanReq = useRequest(
    ({ signal }) => getJson(p('api', 'security', 'scan'), { signal }),
    { enabled: scanMode, deps: [refreshSignal], dedupeKey: 'security:scan', pollMs: scanRunning ? 2000 : 0, onSuccess: (d) => setScanRunning(!!d?.running) },
  );
  const scan = scanReq.data;

  useEffect(() => { setDetail(null); }, [tab, ns]);

  const runScan = async () => {
    setScanError(null); setStarting(true);
    scanReq.setData((prev) => ({ ...(prev || {}), running: true, scanned: 0, total: 0 }));
    setScanRunning(true);
    try {
      const data = await postJson(p('api', 'security', 'scan'), { namespace: nsParam });
      scanReq.setData(data);
      setScanRunning(!!data?.running);
    } catch (e) {
      setScanError(errorMessage(e, 'Scan failed to start'));
      scanReq.setData((prev) => ({ ...(prev || {}), running: false }));
      setScanRunning(false);
    } finally { setStarting(false); }
  };

  if (!status) {
    if (statusReq.error) {
      return <div className="sec-view"><div className="sec-center"><ErrorState error={statusReq.error} title={errorTitle(statusReq.error, 'the Security Center status')} onRetry={statusReq.refetch} busy={statusReq.refetching} /></div></div>;
    }
    return <div className="sec-center"><Loader label="Checking Security Center…" /></div>;
  }

  // No operator, and no scan run yet → the setup / run-scan screen. Wait for the
  // prior/persisted scan to load first so a cached result doesn't flash setup.
  if (scanMode && !scan?.images?.length && !scan?.running) {
    if (scanReq.loading || availReq.loading) return <div className="sec-center"><Loader label="Loading security…" /></div>;
    if (scanReq.error && !scan) {
      return <div className="sec-view"><div className="sec-center"><ErrorState error={scanReq.error} title={errorTitle(scanReq.error, 'scan results')} onRetry={scanReq.refetch} busy={scanReq.refetching} /></div></div>;
    }
    return <SetupState error={status.error} scanAvail={availReq.data || (availReq.error ? { available: false } : null)} onScan={runScan} scanError={scanError} starting={starting} />;
  }

  const nsList = namespaces.filter((n) => n !== 'all');
  const vuln = operatorMode ? vulnReq.data : scan;
  const activeReq = tab === 'resources' ? configReq : tab === 'roles' ? rbacReq : (operatorMode ? vulnReq : scanReq);
  const countList = tab === 'resources' ? (configReq.data?.resources || []) : tab === 'roles' ? (rbacReq.data?.resources || []) : (vuln?.images || []);
  const count = (ns === 'all' ? countList : countList.filter((r) => r.namespace === ns || (r.workloads || []).some((w) => w.namespace === ns))).length;
  const operatorOnlyTab = scanMode && (tab === 'resources' || tab === 'roles');
  const blockingError = !operatorOnlyTab && activeReq.error && !activeReq.data;
  const softError = !operatorOnlyTab && activeReq.error && !!activeReq.data;
  // "No data and no error yet" covers the frame between enabling a request and
  // its effect flipping `loading`, so the table never flashes empty.
  const loading = !operatorOnlyTab && !activeReq.data && !activeReq.error;

  return (
    <div className="sec-view">
      <div className="sec-head">
        <div className="sec-title"><Icon name="shieldCheck" size={20} /> <h1>Security</h1></div>
        <div className="sec-controls">
          <label htmlFor={`${id}-ns`} className="sr-only">Namespace</label>
          <select id={`${id}-ns`} className="sec-nssel" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="all">All namespaces</option>
            {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <SearchBox value={q} onChange={setQ} ariaLabel={`Search ${tab}`} placeholder={`Search ${tab}…`} className="sec-search-box" />
          <span className="sec-count" role="status">{count} items</span>
        </div>
      </div>

      <div className="sec-tabs" role="tablist" aria-label="Security views">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-tab-${k}`}
            data-key={k}
            aria-selected={tab === k}
            aria-controls={`${id}-panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`sec-tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
            onKeyDown={(e) => tablistKeys(e, TAB_KEYS, tab, setTab)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="sec-main">
        <div className="sec-body" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
          {scanMode && scan?.phase === 'preparing' ? (
            <ScanPanel scan={scan} onRescan={runScan} />
          ) : (
            <>
              {scanMode && scan && <ScanPanel scan={scan} onRescan={runScan} />}
              {scanMode && scanError && <ErrorState error={scanError} title="The scan could not be started" compact />}
              {softError && <ErrorState error={activeReq.error} title={errorTitle(activeReq.error, WHAT[tab])} onRetry={activeReq.refetch} busy={activeReq.refetching} compact />}
              {blockingError ? (
                <ErrorState error={activeReq.error} title={errorTitle(activeReq.error, WHAT[tab])} onRetry={activeReq.refetch} busy={activeReq.refetching} />
              ) : loading ? (
                <div className="sec-center"><Loader label="Loading reports…" /></div>
              ) : (
                <>
                  {tab === 'overview' && <VulnTable vuln={vuln} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'image', data: d })} selected={detail?.type === 'image' ? detail.data : null} criticalOnly refetching={activeReq.refetching} />}
                  {tab === 'images' && <VulnTable vuln={vuln} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'image', data: d })} selected={detail?.type === 'image' ? detail.data : null} refetching={activeReq.refetching} />}
                  {tab === 'resources' && (scanMode ? <OperatorNote feature="Resource best-practice checks" /> : <ChecksTable data={configReq.data} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'checks', data: d })} selected={detail?.type === 'checks' ? detail.data : null} label="resource" refetching={configReq.refetching} />)}
                  {tab === 'roles' && (scanMode ? <OperatorNote feature="RBAC risk analysis" /> : <ChecksTable data={rbacReq.data} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'checks', data: d })} selected={detail?.type === 'checks' ? detail.data : null} label="role" refetching={rbacReq.refetching} />)}
                </>
              )}
            </>
          )}
        </div>
        {detail && <FindingDrawer detail={detail} onClose={() => setDetail(null)} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
