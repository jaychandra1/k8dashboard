// The token helpers run as scripts (`node eks-token.js …` in source / Docker
// kubeconfigs) only when Node says they are the main module. Node resolves
// symlinks for the module itself but not for process.argv[1], so a path
// through a symlink (macOS /var → /private/var, a linked folder) once made the
// helpers exit 0 without a word. Run here through a folder link (a junction on
// Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isMainModule, ROOT_DIR } from '../lib/paths.mjs';

const linkTo = (target) => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-')), 'app');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
};

test('isMainModule compares real paths', () => {
  const link = linkTo(ROOT_DIR);
  try {
    const url = pathToFileURL(path.join(ROOT_DIR, 'eks-token.js')).href;
    assert.equal(isMainModule(url, path.join(link, 'eks-token.js')), true);
    assert.equal(isMainModule(url, path.join(ROOT_DIR, 'eks-token.js')), true);
    assert.equal(isMainModule(url, path.join(ROOT_DIR, 'azure-token.js')), false);
    assert.equal(isMainModule(url, undefined), false);
    assert.equal(isMainModule(url, '--token-helper'), false); // the packaged app's argv
  } finally {
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  }
});

test('the token helpers run when started through a linked folder', () => {
  const link = linkTo(ROOT_DIR);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-home-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, AWS_CONFIG_FILE: path.join(home, 'none'), AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'none'), AWS_EC2_METADATA_DISABLED: 'true' };
    const eks = spawnSync(process.execPath, [path.join(link, 'eks-token.js'), '--cluster', 'c', '--region', 'eu-west-1', '--profile', 'k8board-test-none'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(eks.status, 1);
    assert.match(eks.stderr, /^eks-token: /m);
    const az = spawnSync(process.execPath, [path.join(link, 'azure-token.js')], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(az.status, 1);
    assert.match(az.stderr, /^azure-token: /m);
  } finally {
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
