// Advisory details for the vulnerability report download (lib/vuln-details.mjs)
// and the desktop PDF bridge's request checks (electron/report-pdf.cjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cliDetail, operatorDetail, httpLinks, pickCvss, uniqueDetails } from '../lib/vuln-details.mjs';

const require = createRequire(import.meta.url);

describe('advisory details', () => {
  test('Trivy CLI JSON → details: description, dates, CVSS from the severity source, references', () => {
    const d = cliDetail({
      VulnerabilityID: 'CVE-2024-1', PkgName: 'libssl3', InstalledVersion: '3.0.11-1',
      Description: 'Buffer overread.', PublishedDate: '2024-06-27T11:15:00Z', LastModifiedDate: '2024-07-01T00:00:00Z',
      SeveritySource: 'debian', PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2024-1',
      References: ['https://avd.aquasec.com/nvd/cve-2024-1', 'https://www.openssl.org/news/secadv/x.txt', 'file:///etc/passwd'],
      CVSS: { nvd: { V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:H', V3Score: 9.1 }, redhat: { V3Vector: 'CVSS:3.1/AV:N', V3Score: 5.9 } },
    });
    assert.deepEqual(d, {
      id: 'CVE-2024-1', pkg: 'libssl3', installedVersion: '3.0.11-1', description: 'Buffer overread.',
      publishedDate: '2024-06-27T11:15:00Z', lastModifiedDate: '2024-07-01T00:00:00Z',
      // "debian" has no vector: NVD's is used.
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:H', cvssScore: 9.1, cvssSource: 'nvd',
      links: ['https://avd.aquasec.com/nvd/cve-2024-1', 'https://www.openssl.org/news/secadv/x.txt'],
    });
  });

  test('operator entries map the same way; missing fields stay empty', () => {
    assert.deepEqual(operatorDetail({ vulnerabilityID: 'CVE-1', resource: 'x', installedVersion: '1' }), {
      id: 'CVE-1', pkg: 'x', installedVersion: '1', description: '', publishedDate: '', lastModifiedDate: '', links: [],
    });
  });

  test('long descriptions are capped; links are http(s) only, deduplicated and capped', () => {
    assert.equal(cliDetail({ VulnerabilityID: 'C', Description: 'x'.repeat(10000) }).description.length, 4000);
    const many = Array.from({ length: 20 }, (_, i) => `https://e.example/${i}`);
    assert.equal(httpLinks(many[0], many).length, 10);
    assert.deepEqual(httpLinks('javascript:alert(1)', ['data:text/html,x', 'https://a.example/"><script>', 'https://ok.example/a']), ['https://ok.example/a']);
  });

  test('CVSS: v4 wins over v3; no vector → nothing', () => {
    assert.deepEqual(pickCvss({ ghsa: { V3Vector: 'CVSS:3.1/X', V3Score: 7, V40Vector: 'CVSS:4.0/Y', V40Score: 8.7 } }), { cvssVector: 'CVSS:4.0/Y', cvssScore: 8.7, cvssSource: 'ghsa' });
    assert.deepEqual(pickCvss({ nvd: { V3Score: 7 } }), {});
    assert.deepEqual(pickCvss(null), {});
  });

  test('deduplicated by (id, package, installed version)', () => {
    const a = { id: 'C', pkg: 'p', installedVersion: '1', description: 'first' };
    assert.deepEqual(uniqueDetails([a, { ...a, description: 'second' }, { ...a, installedVersion: '2' }]).map((x) => x.description), ['first', 'first']);
  });
});

describe('desktop report PDF bridge: who may ask, and for what', () => {
  const { CHANNEL, registerReportPdf, allowed } = require('../electron/report-pdf.cjs');

  test('the PDF window may load only the report itself and data: images', () => {
    assert.equal(allowed('k8board-report://report/'), true);
    assert.equal(allowed('data:image/png;base64,AAAA'), true);
    for (const url of ['https://example.com/x.png', 'http://127.0.0.1:3001/api/config', 'file:///C:/Windows/win.ini', 'ws://x', 'blob:null/1']) {
      assert.equal(allowed(url), false, url);
    }
  });
  const setup = (allowed) => {
    let handler = null;
    const ipcMain = { handle: (ch, fn) => { assert.equal(ch, CHANNEL); handler = fn; } };
    registerReportPdf({ ipcMain, BrowserWindow: null, session: null, isAllowedSender: () => allowed });
    return handler;
  };

  test('a request from anywhere but the app page is refused', async () => {
    await assert.rejects(setup(false)({}, '<!doctype html><p>x'), /Not allowed/);
  });

  test('only a report document is rendered', async () => {
    const handle = setup(true);
    for (const bad of [null, 42, '', '<html>', `<!doctype html>${'x'.repeat(25 * 1024 * 1024)}`]) {
      await assert.rejects(handle({}, bad), /Not a report/);
    }
  });
});
