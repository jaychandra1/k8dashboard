import { useRef, useState } from 'react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Menu from '../ui/Menu';
import { useOptionalToast } from '../Toast';
import { getJson, p, errorMessage } from '../../lib/api';
import { downloadFile } from '../../lib/download';
import { buildReportModel, reportFileName } from './report/model';
import { reportHtml } from './report/html';
import { buildChecksModel, checksFileName, checksHtml, checksKindOf } from './report/checks';
import { checksCsv, reportCsv } from './report/csv';

// "Download report" in the Security Center drawer's header, for sharing with
// the team that owns what it describes, as a PDF (desktop app), an HTML page
// or a CSV:
//   an image     → its vulnerability report
//   a resource   → its configuration audit (Resources tab) or RBAC
//                  assessment (Roles tab) report
// A report always holds every finding, whatever the drawer is filtered to.
//
// subject: { type: 'image', data } | { type: 'checks', data, which?: 'config' | 'rbac' }

/** The desktop app's report bridge (electron/preload.cjs); absent in a browser. */
const host = () => (typeof window !== 'undefined' ? window.k8boardHost : undefined);
const canPdf = () => typeof host()?.reportPdf === 'function';

/** The report's content in each format, and its file name. */
async function buildReport(subject, { context }) {
  if (subject.type === 'checks') {
    const model = buildChecksModel(subject.data, { which: subject.which, context });
    return { html: () => checksHtml(model), csv: () => checksCsv(model), fileName: (ext) => checksFileName(model, ext) };
  }
  // Advisory details are optional: without them the report links each advisory.
  const details = await getJson(p('api', 'security', 'vulnerabilities', 'details'), { params: { image: subject.data.image } }).catch(() => null);
  const model = buildReportModel(subject.data, { context, details });
  return { html: () => reportHtml(model), csv: () => reportCsv(model), fileName: (ext) => reportFileName(model, ext) };
}

/** Build the report and save it as `format` ('pdf' | 'html' | 'csv'). */
export async function downloadReport(subject, format, { context } = {}) {
  const report = await buildReport(subject, { context });
  if (format === 'csv') {
    downloadFile(report.csv(), report.fileName('csv'), 'text/csv;charset=utf-8');
  } else if (format === 'pdf') {
    // Electron prefixes a refused call with "Error invoking remote method '…': Error: ".
    const bytes = await host().reportPdf(report.html()).catch((e) => {
      throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    });
    downloadFile(new Blob([bytes], { type: 'application/pdf' }), report.fileName('pdf'));
  } else {
    downloadFile(report.html(), report.fileName('html'), 'text/html;charset=utf-8');
  }
}

/** "vulnerability" | "configuration audit" | "RBAC assessment" */
const noun = (subject) => (subject.type === 'image' ? 'vulnerability' : checksKindOf(subject.data, subject.which) === 'rbac' ? 'RBAC assessment' : 'configuration audit');

export default function ReportDownload({ subject, context, disabled = false }) {
  const toast = useOptionalToast();
  const btnRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (format) => {
    setBusy(true);
    try {
      await downloadReport(subject, format, { context });
    } catch (e) {
      toast?.error(errorMessage(e, 'Could not create the report'), { title: 'Security report' });
    } finally {
      setBusy(false);
      btnRef.current?.focus({ preventScroll: true });
    }
  };

  const items = [
    { heading: true, label: 'Download report' },
    canPdf() && { key: 'pdf', label: 'PDF report', icon: 'fileText', onSelect: () => run('pdf') },
    { key: 'html', label: 'HTML report', icon: 'manifest', onSelect: () => run('html') },
    { key: 'csv', label: 'CSV spreadsheet', icon: 'sheet', onSelect: () => run('csv') },
  ].filter(Boolean);

  const label = disabled ? 'Download report (available once the image is scanned)' : busy ? 'Preparing the report…' : 'Download report';
  return (
    <>
      <Tooltip content={label}>
        <Button
          ref={btnRef}
          variant="ghost"
          size="sm"
          iconOnly
          icon="download"
          ariaLabel={disabled ? label : `Download ${noun(subject)} report`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          busy={busy}
          disabled={disabled}
          className="sec-drawer-x"
          onClick={(e) => {
            if (menu) { setMenu(null); return; }
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 220, y: r.bottom + 4 });
          }}
        />
      </Tooltip>
      {menu && (
        <Menu
          open
          x={menu.x}
          y={menu.y}
          minWidth={220}
          items={items}
          ariaLabel="Download report"
          returnFocusTo={btnRef.current}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
