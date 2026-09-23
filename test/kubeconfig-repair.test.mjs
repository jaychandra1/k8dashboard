// lib/kubeconfig-repair.mjs: rewrite only *our* stale helper exec entries,
// leave every other user alone, back the file up once and write atomically.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { repairExecEntries, staleReason, deriveHelperInvocation } from '../lib/kubeconfig-repair.mjs';
import { helperFile, TOKEN_HELPER_FLAG } from '../lib/paths.mjs';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const stubLog = () => {
  const lines = { info: [], warn: [] };
  return { lines, info: (msg, f) => lines.info.push({ msg, ...f }), warn: (msg, f) => lines.warn.push({ msg, ...f }), error: () => {}, debug: () => {} };
};

const MAC_APP = '/Applications/KubePilot.app/Contents/MacOS/KubePilot';
const OLD_EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\K8Sight\\K8Sight.exe'; // gone from disk
const OLD_HELPER = 'C:\\Users\\me\\AppData\\Local\\Programs\\K8Sight\\resources\\app\\eks-token.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-repair-'));
  tmpDirs.push(dir);
  // A present "app binary" for the legacy-env case.
  const presentExe = path.join(dir, 'KubePilot.exe');
  fs.writeFileSync(presentExe, '');
  const doc = {
    apiVersion: 'v1', kind: 'Config', 'current-context': 'stale',
    clusters: [{ name: 'c', cluster: { server: 'https://example.eks.amazonaws.com' } }],
    contexts: [{ name: 'stale', context: { cluster: 'c', user: 'stale' } }],
    users: [
      // 1. old packaged build, binary no longer exists
      { name: 'stale', user: { exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1', command: OLD_EXE,
        args: [OLD_HELPER, '--cluster', 'prod', '--region', 'eu-west-1', '--profile', 'sso-prod'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }], interactiveMode: 'Never', provideClusterInfo: false,
      } } },
      // 2. hand-written aws CLI entry — never ours
      { name: 'awscli', user: { exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'aws',
        args: ['eks', 'get-token', '--cluster-name', 'prod', '--region', 'eu-west-1'],
      } } },
      // 3. dev entry: real node binary that exists, helper file, legacy env — fine as is
      { name: 'dev', user: { exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1', command: process.execPath,
        args: [helperFile('eks'), '--cluster', 'dev', '--region', 'us-east-1'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
      } } },
      // 4. legacy ELECTRON_RUN_AS_NODE form whose binary still exists
      { name: 'legacy', user: { exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1', command: presentExe,
        args: [path.join(dir, 'resources', 'app', 'azure-token.js'), '--server-id', 'srv-id', '--tenant', 'tenant-id'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }], interactiveMode: 'Never', provideClusterInfo: false,
      } } },
      // 5. certificate user — no exec at all
      { name: 'cert', user: { 'client-certificate-data': 'AAA=', 'client-key-data': 'BBB=' } },
    ],
  };
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, yaml.dump(doc));
  return { dir, file, presentExe };
}

const users = (file) => Object.fromEntries(yaml.load(fs.readFileSync(file, 'utf8')).users.map((u) => [u.name, u.user]));

describe('repairExecEntries (Electron runtime)', () => {
  test('rewrites stale + legacy entries to --token-helper, leaves others untouched', () => {
    const { dir, file } = fixture();
    const before = users(file);
    const log = stubLog();
    const { repaired } = repairExecEntries(file, { execEntryOpts: { electron: true, execPath: MAC_APP }, log });
    assert.deepEqual(repaired.sort(), ['legacy', 'stale']);

    const u = users(file);
    assert.deepEqual(u.stale.exec, {
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: MAC_APP,
      args: [TOKEN_HELPER_FLAG, 'eks', '--cluster', 'prod', '--region', 'eu-west-1', '--profile', 'sso-prod'],
      interactiveMode: 'Never',
      provideClusterInfo: false,
    });
    assert.equal('env' in u.stale.exec, false, 'no ELECTRON_RUN_AS_NODE env in the new form');
    assert.deepEqual(u.legacy.exec.args, [TOKEN_HELPER_FLAG, 'azure', '--server-id', 'srv-id', '--tenant', 'tenant-id']);
    assert.equal(u.legacy.exec.command, MAC_APP);

    assert.deepEqual(u.awscli, before.awscli);
    assert.deepEqual(u.dev, before.dev);
    assert.deepEqual(u.cert, before.cert);

    // one info line per repaired user, a single backup, file still parses
    assert.deepEqual(log.lines.info.map((l) => l.user).sort(), ['legacy', 'stale']);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.kubepilot-backup-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(yaml.load(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).users.map((x) => x.name), Object.keys(before));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file left behind');

    // second pass: nothing left to do, no second backup
    const again = repairExecEntries(file, { execEntryOpts: { electron: true, execPath: MAC_APP }, log });
    assert.deepEqual(again.repaired, []);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('config.kubepilot-backup-')).length, 1);
  });

  test('a --token-helper entry whose binary moved is re-pointed', () => {
    const { dir, file } = fixture();
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    doc.users = [{ name: 'moved', user: { exec: {
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: path.join(dir, 'gone', 'KubePilot'),
      args: [TOKEN_HELPER_FLAG, 'eks', '--cluster', 'x', '--region', 'eu-west-1'],
      interactiveMode: 'Never', provideClusterInfo: false,
    } } }];
    fs.writeFileSync(file, yaml.dump(doc));
    const { repaired } = repairExecEntries(file, { execEntryOpts: { electron: true, execPath: MAC_APP }, log: stubLog() });
    assert.deepEqual(repaired, ['moved']);
    assert.equal(users(file).moved.exec.command, MAC_APP);
    assert.deepEqual(users(file).moved.exec.args, [TOKEN_HELPER_FLAG, 'eks', '--cluster', 'x', '--region', 'eu-west-1']);
  });
});

describe('repairExecEntries (plain Node runtime)', () => {
  test('stale packaged entry becomes `node <helper> …`', () => {
    const { file } = fixture();
    const { repaired } = repairExecEntries(file, { execEntryOpts: { electron: false, execPath: '/usr/local/bin/node' }, log: stubLog() });
    assert.deepEqual(repaired.sort(), ['legacy', 'stale']);
    const u = users(file);
    assert.equal(u.stale.exec.command, '/usr/local/bin/node');
    assert.deepEqual(u.stale.exec.args, [helperFile('eks'), '--cluster', 'prod', '--region', 'eu-west-1', '--profile', 'sso-prod']);
    assert.deepEqual(u.legacy.exec.args, [helperFile('azure'), '--server-id', 'srv-id', '--tenant', 'tenant-id']);
    assert.equal('env' in u.stale.exec, false);
  });
});

describe('repairExecEntries safety', () => {
  test('never rewrites a file that fails to parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-repair-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, 'users: [\n  - name: broken\n    user: { exec: { command: "x"');
    const log = stubLog();
    const { repaired } = repairExecEntries(file, { log });
    assert.deepEqual(repaired, []);
    assert.equal(fs.readFileSync(file, 'utf8').startsWith('users: ['), true);
    assert.equal(log.lines.warn.length, 1);
    assert.equal(fs.readdirSync(dir).length, 1, 'no backup, no temp file');
  });

  test('missing file and non-mapping documents are no-ops', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-repair-'));
    tmpDirs.push(dir);
    assert.deepEqual(repairExecEntries(path.join(dir, 'nope')).repaired, []);
    const file = path.join(dir, 'list');
    fs.writeFileSync(file, '- a\n- b\n');
    assert.deepEqual(repairExecEntries(file).repaired, []);
    assert.equal(fs.readFileSync(file, 'utf8'), '- a\n- b\n');
  });

  test('a stale-looking entry without recoverable flags is left alone (warned)', () => {
    const { file } = fixture();
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    doc.users = [{ name: 'odd', user: { exec: { command: OLD_EXE, args: [OLD_HELPER] } } }];
    fs.writeFileSync(file, yaml.dump(doc));
    const log = stubLog();
    assert.deepEqual(repairExecEntries(file, { log }).repaired, []);
    assert.equal(log.lines.warn.length, 1);
    assert.deepEqual(users(file).odd.exec, { command: OLD_EXE, args: [OLD_HELPER] });
  });
});

describe('staleReason / deriveHelperInvocation', () => {
  const exists = () => true;
  const missing = () => false;
  test('only our entries are candidates', () => {
    assert.equal(staleReason({ command: 'aws', args: ['eks', 'get-token'] }, { commandExists: missing }), null);
    assert.equal(staleReason({ command: 'kubelogin', args: ['get-token'] }, { commandExists: missing }), null);
    assert.equal(staleReason(undefined), null);
  });
  test('missing command wins; legacy env only counts with an app binary', () => {
    assert.equal(staleReason({ command: '/x/KubePilot', args: [TOKEN_HELPER_FLAG, 'eks'] }, { commandExists: missing }), 'command-missing');
    assert.equal(staleReason({ command: '/x/node', args: ['/y/eks-token.js'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }, { commandExists: exists }), null);
    assert.equal(staleReason({ command: 'C:\\P\\k8dashboard.exe', args: ['C:\\P\\resources\\app\\eks-token.js'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }, { commandExists: exists }), 'legacy-run-as-node');
    assert.equal(staleReason({ command: '/opt/KubePilot/resources/app/../KubePilot', args: [TOKEN_HELPER_FLAG, 'eks'] }, { commandExists: exists }), null);
  });
  test('recovers helper kind and flags from every historical shape', () => {
    assert.deepEqual(deriveHelperInvocation({ args: ['/a/eks-token.js', '--cluster', 'c', '--region', 'r'] }), { helper: 'eks', args: ['--cluster', 'c', '--region', 'r'] });
    assert.deepEqual(deriveHelperInvocation({ args: ['C:\\a\\azure-token.js', '--server-id', 's'] }), { helper: 'azure', args: ['--server-id', 's'] });
    assert.deepEqual(deriveHelperInvocation({ args: [TOKEN_HELPER_FLAG, 'azure', '--server-id', 's', '--tenant', 't'] }), { helper: 'azure', args: ['--server-id', 's', '--tenant', 't'] });
    assert.equal(deriveHelperInvocation({ args: ['/a/eks-token.js', '--region', 'r'] }), null, 'eks needs --cluster');
    assert.equal(deriveHelperInvocation({ args: [TOKEN_HELPER_FLAG, 'gcp', '--cluster', 'c'] }), null);
  });
});
