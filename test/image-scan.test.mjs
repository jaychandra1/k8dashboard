// The Docker image's vulnerability scan (CI, "Fail on fixable HIGH/CRITICAL
// vulnerabilities"): what scans, what is pinned, and what is accepted on
// purpose (.trivyignore.yaml). These are checks on the files, not a scan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../lib/paths.mjs';
import { TRIVY_VERSION } from '../trivy-scan.js';

const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
const dockerfile = read('Dockerfile');
const ci = read('.github/workflows/ci.yml');
const ignores = read('.trivyignore.yaml');
const arg = (name) => (dockerfile.match(new RegExp(`^ARG ${name}=(.+)$`, 'm')) || [])[1];

describe('the scanner', () => {
  test('CI scans with the Trivy the image ships, named explicitly (never the action\'s older default)', () => {
    const versions = [...ci.matchAll(/^\s+version: v(\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);
    assert.deepEqual(versions, [arg('TRIVY_VERSION')], 'one `version:` on the scan step, equal to TRIVY_VERSION in the Dockerfile');
    assert.equal(arg('TRIVY_VERSION'), TRIVY_VERSION, 'the Dockerfile and trivy-scan.js pin the same Trivy');
  });

  test('the action is pinned to a commit, the same one in both steps; the gate reuses the installed Trivy', () => {
    const uses = [...ci.matchAll(/uses: aquasecurity\/trivy-action@(\S+)(?: # (\S+))?/g)].map((m) => [m[1], m[2]]);
    assert.equal(uses.length, 2);
    for (const [ref, tag] of uses) {
      assert.match(ref, /^[0-9a-f]{40}$/, 'a full commit SHA, not a tag');
      assert.match(tag || '', /^v\d+\.\d+\.\d+$/, 'with the release it is, as a comment');
    }
    assert.equal(uses[0][0], uses[1][0]);
    const gate = ci.slice(ci.indexOf('- name: Fail on fixable HIGH/CRITICAL vulnerabilities'));
    const step = gate.slice(0, gate.indexOf('\n\n'));
    assert.match(step, /exit-code: '1'/);
    assert.match(step, /severity: CRITICAL,HIGH/);
    assert.match(step, /ignore-unfixed: true/);
    assert.match(step, /trivyignores: \.trivyignore\.yaml/);
    assert.match(step, /skip-setup-trivy: true/);
  });
});

describe('what the image is built from', () => {
  test('the Go that compiles kubelogin is pinned by digest and carries the net/http fix', () => {
    const go = arg('GO_IMAGE');
    const m = /^golang:(\d+)\.(\d+)\.(\d+)-alpine@sha256:[0-9a-f]{64}$/.exec(go);
    assert.ok(m, go);
    const [major, minor, patch] = m.slice(1).map(Number);
    // CVE-2026-97054 is fixed in Go 1.26.11 and 1.27.4.
    const fixed = major > 1 || minor > 27 || (minor === 27 && patch >= 4) || (minor === 26 && patch >= 11);
    assert.ok(fixed, `${go} is older than the Go that fixes CVE-2026-97054`);
    // kubelogin is built with that Go and no other (GOTOOLCHAIN=local).
    assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM \$\{GO_IMAGE\} AS kubelogin-build/);
    assert.match(dockerfile, /ENV CGO_ENABLED=0 GOTOOLCHAIN=local/);
    assert.match(dockerfile, /COPY --from=kubelogin-build \/out\/kubectl-oidc_login \/usr\/local\/bin\//);
  });

  test('every other base and tool is pinned too', () => {
    assert.match(arg('NODE_IMAGE'), /^node:\d+-alpine@sha256:[0-9a-f]{64}$/);
    assert.match(arg('KUBECTL_VERSION'), /^v\d+\.\d+\.\d+$/);
    assert.match(arg('KUBELOGIN_VERSION'), /^v\d+\.\d+\.\d+$/);
    assert.match(arg('TRIVY_VERSION'), /^\d+\.\d+\.\d+$/);
    assert.equal((read('run.sh').match(/^KUBECTL_VERSION="(.+)"$/m) || [])[1], arg('KUBECTL_VERSION'), 'run.sh shares KUBECTL_VERSION');
  });
});

describe('findings accepted on purpose (.trivyignore.yaml)', () => {
  // The file's entries: id, paths, statement, expired_at.
  const entries = ignores
    .split(/\n {2}- id: /)
    .slice(1)
    .map((block) => ({
      id: block.split('\n')[0].trim(),
      paths: [...block.matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]),
      statement: (block.match(/^ {4}statement: "(.+)"$/m) || [])[1],
      expires: (block.match(/^ {4}expired_at: (\d{4}-\d{2}-\d{2})$/m) || [])[1],
    }));

  test('each one names a CVE, the one binary it is in, a reason, and a date it stops being accepted', () => {
    assert.ok(entries.length >= 1);
    for (const e of entries) {
      assert.match(e.id, /^CVE-\d{4}-\d{4,}$/, e.id);
      assert.equal(e.paths.length, 1, `${e.id}: scoped to exactly one binary`);
      assert.match(e.paths[0], /^usr\/local\/bin\/[\w-]+$/, `${e.id}: ${e.paths[0]}`);
      assert.ok(e.statement && e.statement.length >= 30, `${e.id}: says why`);
      assert.ok(e.expires && !Number.isNaN(Date.parse(e.expires)), `${e.id}: expires`);
      // Not parked for good: at most a few months ahead of when it was written.
      assert.ok(Date.parse(e.expires) <= Date.parse('2027-03-31'), `${e.id}: expiry ${e.expires} is too far away`);
    }
    // Nothing is accepted for the whole image, the OS packages or the app's own modules.
    assert.doesNotMatch(ignores, /^\s+- (app|usr\/lib|lib)\//m);
    assert.equal(/^misconfigurations:|^secrets:|^licenses:/m.test(ignores), false);
  });

  test('CVE-2026-97054: accepted only in the two upstream binaries with no fixed release; kubelogin is rebuilt instead', () => {
    const paths = entries.filter((e) => e.id === 'CVE-2026-97054').map((e) => e.paths[0]).sort();
    assert.deepEqual(paths, ['usr/local/bin/kubectl', 'usr/local/bin/trivy']);
    assert.equal(entries.some((e) => e.paths[0] === 'usr/local/bin/kubectl-oidc_login'), false, 'the binary built here is fixed, not excused');
  });

  test('the reason given for Trivy holds: K8Board only ever runs it as a one-shot client', () => {
    const scan = read('trivy-scan.js');
    assert.match(scan, /const args = \['image', '--quiet', '--format', 'json'/);
    assert.doesNotMatch(scan, /['"]server['"]|--listen|['"]client['"]/);
    // …and nothing in the backend starts `kubectl proxy` (an HTTP server).
    for (const f of ['server.js', 'lib/kubectl.mjs', 'lib/helm-shell.mjs']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT_DIR, f), 'utf8'), /['"]proxy['"]\s*[,\]]/, f);
  });
});
