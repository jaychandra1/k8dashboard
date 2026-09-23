// lib/paths.mjs execEntry(): the single place that decides how a kubeconfig
// exec entry launches the bundled token helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execEntry, helperFile, ROOT_DIR, TOKEN_HELPER_FLAG } from '../lib/paths.mjs';

describe('execEntry', () => {
  test('Electron runtime: re-enters the app binary with --token-helper and no env', () => {
    const e = execEntry('eks', ['--cluster', 'c', '--region', 'eu-west-1', '--profile', 'p'], { electron: true, execPath: 'C:\\Apps\\KubePilot\\KubePilot.exe' });
    assert.deepEqual(e, {
      command: 'C:\\Apps\\KubePilot\\KubePilot.exe',
      args: [TOKEN_HELPER_FLAG, 'eks', '--cluster', 'c', '--region', 'eu-west-1', '--profile', 'p'],
    });
    assert.equal('env' in e, false);
  });

  test('Electron runtime: prefers KUBEPILOT_APP_EXEC (set by electron/main.cjs) over process.execPath', () => {
    const prev = process.env.KUBEPILOT_APP_EXEC;
    process.env.KUBEPILOT_APP_EXEC = '/Applications/KubePilot.app/Contents/MacOS/KubePilot';
    try {
      assert.equal(execEntry('azure', ['--server-id', 's'], { electron: true }).command, '/Applications/KubePilot.app/Contents/MacOS/KubePilot');
    } finally {
      if (prev === undefined) delete process.env.KUBEPILOT_APP_EXEC; else process.env.KUBEPILOT_APP_EXEC = prev;
    }
    assert.equal(execEntry('azure', [], { electron: true }).command, process.execPath);
  });

  test('plain Node runtime: node + helper file next to lib/', () => {
    const e = execEntry('azure', ['--server-id', 's', '--tenant', 't'], { electron: false, execPath: '/usr/bin/node' });
    assert.deepEqual(e, { command: '/usr/bin/node', args: [path.join(ROOT_DIR, 'azure-token.js'), '--server-id', 's', '--tenant', 't'] });
    assert.equal(helperFile('eks'), path.join(ROOT_DIR, 'eks-token.js'));
    assert.equal(execEntry('eks', [], { electron: false }).command, process.execPath);
  });

  test('plain Node runtime honours KUBEPILOT_NODE_BIN', () => {
    const prev = process.env.KUBEPILOT_NODE_BIN;
    process.env.KUBEPILOT_NODE_BIN = '/opt/node/bin/node';
    try {
      assert.equal(execEntry('eks', [], { electron: false }).command, '/opt/node/bin/node');
    } finally {
      if (prev === undefined) delete process.env.KUBEPILOT_NODE_BIN; else process.env.KUBEPILOT_NODE_BIN = prev;
    }
  });

  test('detects the runtime from process.versions.electron by default', () => {
    const expectElectron = Boolean(process.versions.electron);
    assert.equal(execEntry('eks', []).args[0] === TOKEN_HELPER_FLAG, expectElectron);
  });

  test('rejects unknown helpers', () => {
    assert.throws(() => execEntry('gcp', []), /unknown token helper/);
    assert.throws(() => helperFile(''), /unknown token helper/);
  });
});
