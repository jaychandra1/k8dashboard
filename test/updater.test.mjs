// Help → Check for Updates: version comparison and the update check itself.
// K8Board installs no update and reads no release server: a Windows copy asks
// the Microsoft Store (the request itself is covered in store-updates.test.mjs),
// any other copy has nobody to ask. Also the release signing the release
// workflow uses (lib/updater/verify.mjs, keys.mjs). Nothing here uses the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions,
  isNewerVersion,
  isPrerelease,
  normalizeVersion,
  parseVersion,
} from '../lib/updater/version.mjs';
import { CHECKSUMS_ASSET, SIGNATURE_ASSET, signedMessage, verifyChecksumsSignature } from '../lib/updater/verify.mjs';
import { RELEASE_PUBLIC_KEYS } from '../lib/updater/keys.mjs';
import { createUpdateService } from '../lib/updater/service.mjs';
import { MESSAGES, UpdateError, updateError } from '../lib/updater/errors.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

describe('version comparison', () => {
  test('update decisions', () => {
    assert.equal(isNewerVersion('1.3.0', '1.3.0'), false);
    assert.equal(isNewerVersion('1.3.1', '1.3.0'), true);
    assert.equal(isNewerVersion('1.4.0', '1.3.0'), true);
    assert.equal(isNewerVersion('2.0.0', '1.3.0'), true);
    assert.equal(isNewerVersion('1.2.9', '1.3.0'), false);
    assert.equal(isNewerVersion('1.10.0', '1.9.0'), true, 'numeric, not string, comparison');
  });
  test('normalisation and prereleases', () => {
    assert.equal(normalizeVersion('v1.3.0'), '1.3.0');
    assert.equal(normalizeVersion(' V2.0.1 '), '2.0.1');
    assert.equal(normalizeVersion('1.4.0+build.7'), '1.4.0');
    assert.equal(normalizeVersion('1.3'), null);
    assert.equal(normalizeVersion('latest'), null);
    for (const v of ['1.4.0-beta.1', '1.4.0-alpha.1', '1.4.0-rc.1', 'v2.0.0-next'])
      assert.equal(isPrerelease(v), true, v);
    assert.equal(isPrerelease('1.4.0'), false);
    assert.deepEqual(parseVersion('1.4.0-rc.1').prerelease, ['rc', 1]);
  });
  test('SemVer precedence for prereleases', () => {
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < order.length; i++)
      assert.equal(compareVersions(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
    assert.throws(() => compareVersions('nope', '1.0.0'), TypeError);
  });
});

describe('the update check', () => {
  // `answer` stands in for the Store's catalog (lib/updater/store.mjs).
  const storeCopy = (answer, { current = '1.3.0' } = {}) => {
    const asked = [];
    const svc = createUpdateService({
      currentVersion: current,
      managedBy: 'store',
      store: { latest: async () => { asked.push('store'); return answer(); } },
    });
    return { svc, asked };
  };

  test('before a check: idle, with the running version', () => {
    const { svc, asked } = storeCopy(() => ({ version: '9.9.9' }), { current: 'v1.3.0' });
    assert.deepEqual(svc.snapshot(), { phase: 'idle', currentVersion: '1.3.0', latest: null, managedBy: 'store' });
    assert.deepEqual(asked, []);
  });

  test('Windows: a newer version in the Store → available, with the Store version', async () => {
    const { svc, asked } = storeCopy(() => ({ version: '1.4.0', packageVersion: '1.4.0.0' }));
    assert.deepEqual(await svc.check(), {
      phase: 'available',
      currentVersion: '1.3.0',
      latest: { version: '1.4.0' },
      managedBy: 'store',
    });
    assert.deepEqual(asked, ['store']);
    assert.deepEqual(svc.snapshot().latest, { version: '1.4.0' });
  });

  test('Windows: the Store has this version, or an older one → up to date', async () => {
    for (const version of ['1.3.0', '1.2.9']) {
      const { svc } = storeCopy(() => ({ version }));
      assert.deepEqual(await svc.check(), { phase: 'up-to-date', currentVersion: '1.3.0', latest: null, managedBy: 'store' }, version);
    }
  });

  test("Windows: the Store can't be asked → phase 'store' (not a failure); asking again works", async () => {
    let down = true;
    const { svc, asked } = storeCopy(() => {
      if (down) throw updateError('offline');
      return { version: '1.4.0' };
    });
    assert.deepEqual(await svc.check(), { phase: 'store', currentVersion: '1.3.0', latest: null, managedBy: 'store' });
    down = false;
    assert.equal((await svc.check()).phase, 'available');
    down = true;
    assert.deepEqual((await svc.check()).latest, null, 'an earlier answer is not repeated');
    assert.equal(asked.length, 3);
  });

  test('Windows: a version K8Board cannot read, or no Store client → phase store', async () => {
    const odd = storeCopy(() => ({ version: '1.4.0' }), { current: 'unknown' });
    assert.deepEqual(await odd.svc.check(), { phase: 'store', currentVersion: 'unknown', latest: null, managedBy: 'store' });
    assert.deepEqual(odd.asked, [], 'nothing to compare, so nobody is asked');
    const none = createUpdateService({ currentVersion: '1.3.0', managedBy: 'store' });
    assert.equal((await none.check()).phase, 'store');
  });

  test('one check at a time', async () => {
    let release;
    const { svc } = storeCopy(() => new Promise((resolve) => { release = () => resolve({ version: '1.3.0' }); }));
    const first = svc.check();
    assert.equal(svc.snapshot().phase, 'checking');
    await assert.rejects(svc.check(), (e) => e instanceof UpdateError && e.code === 'busy' && e.status === 409);
    release();
    assert.equal((await first).phase, 'up-to-date');
  });

  test('any other copy (macOS, Linux, a container, a source checkout) has nobody to ask', async () => {
    const asked = [];
    const svc = createUpdateService({
      currentVersion: '1.3.0',
      store: { latest: async () => { asked.push('store'); return { version: '9.9.9' }; } },
    });
    assert.deepEqual(await svc.check(), { phase: 'unavailable', currentVersion: '1.3.0', latest: null, managedBy: null });
    assert.deepEqual(asked, []);
  });

  test('the service can only look: it has nothing that downloads, installs or restarts', () => {
    const { svc } = storeCopy(() => ({ version: '1.4.0' }));
    assert.deepEqual(Object.keys(svc).sort(), ['check', 'snapshot']);
    assert.deepEqual(Object.keys(svc.snapshot()).sort(), ['currentVersion', 'latest', 'managedBy', 'phase']);
  });
});

describe('the app holds no release server', () => {
  test('the in-app updater is gone: no release lookup, download, installer or desktop update host', () => {
    for (const gone of ['lib/updater/github.mjs', 'lib/updater/download.mjs', 'lib/updater/install.mjs', 'lib/updater/host.mjs', 'lib/updater/platform.mjs', 'electron/update-host.cjs'])
      assert.equal(fs.existsSync(path.join(ROOT_DIR, gone)), false, gone);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.equal('releaseRepository' in pkg, false, 'package.json names no release repository');
    for (const f of fs.readdirSync(path.join(ROOT_DIR, 'lib', 'updater')))
      assert.doesNotMatch(fs.readFileSync(path.join(ROOT_DIR, 'lib', 'updater', f), 'utf8'), /api\.github\.com|releases\/latest|browser_download_url/, f);
  });

  test('the desktop shell marks Windows copies as Store copies and offers the check only there', () => {
    const main = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'main.cjs'), 'utf8');
    assert.match(main, /if \(process\.platform === 'win32'\) env\.K8BOARD_INSTALL_MANAGED_BY = 'store';/);
    assert.match(main, /\.\.\.\(process\.platform === 'win32' \? \[\{ label: 'Check for Updates'/);
    assert.doesNotMatch(main, /update-host|updateHost|UPDATE_DIR|INSTALL_KIND|update-result/);
    const preload = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'preload.cjs'), 'utf8');
    assert.match(preload, /updates: process\.platform === 'win32',/);
  });

  test('messages name no hosting service', () => {
    for (const [code, message] of Object.entries(MESSAGES)) assert.doesNotMatch(message, /github|release page|https?:/i, code);
    assert.equal(updateError('nope').message, MESSAGES.failed);
  });
});

describe('release signing (used by the release workflow, not by the app)', () => {
  const good = 'a'.repeat(64);

  test('signed checksum list: version-bound Ed25519 signature from a listed key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const text = `${good}  K8Board-windows.exe\n`;
    const signature = crypto.sign(null, signedMessage('1.4.0', text), privateKey).toString('base64');
    const ok = (o) => verifyChecksumsSignature({ version: '1.4.0', checksumsText: text, signature, keys: [pub], ...o });
    assert.equal(ok(), true);
    assert.equal(ok({ signature: `${signature}\n` }), true, 'trailing newline in the .sig file');
    assert.equal(ok({ keys: [other, pub] }), true, 'any listed key');
    assert.equal(ok({ keys: [other] }), false, 'another key');
    assert.equal(ok({ keys: [] }), false);
    assert.equal(ok({ version: '1.5.0' }), false, 'signature is bound to its version');
    assert.equal(ok({ checksumsText: text.replace(good.slice(0, 4), 'ffff') }), false, 'tampered list');
    assert.equal(ok({ signature: 'not base64 at all' }), false);
    assert.equal(ok({ keys: ['bm90IGEga2V5'] }), false, 'malformed key');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    assert.equal(ok({ keys: [rsa.export({ type: 'spki', format: 'der' }).toString('base64')] }), false, 'non-Ed25519 key');
    assert.deepEqual([CHECKSUMS_ASSET, SIGNATURE_ASSET], ['SHA256SUMS.txt', 'SHA256SUMS.txt.sig']);
  });

  test('the listed release keys are valid Ed25519 keys, where the workflow and its scripts look for them', () => {
    assert.ok(RELEASE_PUBLIC_KEYS.length >= 1);
    for (const k of RELEASE_PUBLIC_KEYS) {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      assert.equal(key.asymmetricKeyType, 'ed25519');
    }
    const wf = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(wf, /import\('\.\/lib\/updater\/keys\.mjs'\)\.then\(\(m\) => console\.log\(m\.RELEASE_PUBLIC_KEYS\.length\)\)/);
    assert.match(wf, /run: node scripts\/sign-release\.mjs dist "\$VERSION"/);
    const sign = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'sign-release.mjs'), 'utf8');
    for (const from of ['../lib/updater/keys.mjs', '../lib/updater/verify.mjs', '../lib/updater/version.mjs']) assert.ok(sign.includes(`from '${from}'`), from);
    const keygen = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'release-signing-keygen.mjs'), 'utf8');
    assert.match(fs.readFileSync(path.join(ROOT_DIR, 'lib', 'updater', 'keys.mjs'), 'utf8'), /export const RELEASE_PUBLIC_KEYS = \[([\s\S]*?)\];/, 'the shape the key generator rewrites');
    assert.ok(keysFileOf(keygen));
  });
});

// The key generator edits lib/updater/keys.mjs in place: it must still point there.
function keysFileOf(source) {
  return /path\.join\(repo, 'lib', 'updater', 'keys\.mjs'\)/.test(source);
}
