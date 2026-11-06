// The credential-helper gate (lib/exec-gate.mjs): one helper run per user at a
// time, a failed run marks the user as needing a sign-in, and its text loses
// the Electron runtime's log lines.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createExecGate, cleanHelperOutput, asClusterAuthError } from '../lib/exec-gate.mjs';

// What a 1.7.x helper printed on Windows (the user's report).
const NOISY = [
  '[7996:1106/160352.881:ERROR:net\\disk_cache\\cache_util_win.cc:25] Unable to move the cache: Access is denied. (0x5)',
  '[7996:1106/160352.881:ERROR:net\\disk_cache\\disk_cache.cc:290] Unable to create cache',
  '[7996:1106/160352.881:ERROR:gpu\\ipc\\host\\gpu_disk_cache.cc:737] Gpu Cache Creation failed: -2',
  "k8board token-helper: The SSO session token associated with profile=sso-dev was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
].join('\n');

function fakeKubeConfig(impl) {
  const calls = [];
  const kc = { execAuth: { getCredential: async (user) => { calls.push(user.name); return impl(user, calls.length); } } };
  return { kc, calls };
}

describe('cleanHelperOutput', () => {
  test('drops runtime log lines and keeps the helper message', () => {
    assert.equal(cleanHelperOutput(NOISY), NOISY.split('\n')[3]);
    assert.equal(cleanHelperOutput('[1234:5678:1106/160352.881:WARNING:foo.cc(12)] x\nreal error'), 'real error');
    assert.equal(cleanHelperOutput('plain text [not a log line]'), 'plain text [not a log line]');
    assert.equal(cleanHelperOutput(undefined), '');
  });

  test('asClusterAuthError marks the error and cleans its message once', () => {
    const e = asClusterAuthError(new Error(NOISY));
    assert.equal(e.clusterAuth, true);
    assert.match(e.message, /^k8board token-helper: The SSO session token/);
    assert.equal(asClusterAuthError(e), e);
    const syntax = asClusterAuthError(new SyntaxError('Unexpected end of JSON input'));
    assert.ok(syntax instanceof SyntaxError, 'the error kind is kept for classification');
  });
});

describe('createExecGate', () => {
  test('requests waiting at the same time share one helper run', async () => {
    let release;
    const gate = createExecGate();
    const { kc, calls } = fakeKubeConfig((user, n) => (n === 1 ? new Promise((r) => { release = r; }) : { status: { token: 't2' } }));
    gate.attach(kc);
    const runs = [1, 2, 3, 4].map(() => kc.execAuth.getCredential({ name: 'dev' }));
    await new Promise((r) => setImmediate(r));
    release({ status: { token: 't' } });
    const out = await Promise.all(runs);
    assert.deepEqual(calls, ['dev']);
    assert.ok(out.every((c) => c.status.token === 't'));
    // A later request runs it again (client-node's own cache sits in front of this in real use).
    await kc.execAuth.getCredential({ name: 'dev' });
    assert.equal(calls.length, 2);
  });

  test('a failed run blocks that user: no more helper runs until cleared', async () => {
    const gate = createExecGate();
    const { kc, calls } = fakeKubeConfig(() => { throw new Error(NOISY); });
    gate.attach(kc);
    const first = await Promise.allSettled([1, 2, 3].map(() => kc.execAuth.getCredential({ name: 'dev' })));
    assert.equal(calls.length, 1, 'one run for the whole burst');
    assert.ok(first.every((r) => r.status === 'rejected' && r.reason.clusterAuth));
    assert.doesNotMatch(first[0].reason.message, /disk_cache|Gpu Cache/);
    await assert.rejects(kc.execAuth.getCredential({ name: 'dev' }), (e) => e.clusterAuth);
    assert.equal(calls.length, 1, 'blocked: failed at once');
    assert.ok(gate.blockedError('dev'));
    // Another user isn't affected.
    await assert.rejects(kc.execAuth.getCredential({ name: 'prod' }));
    assert.equal(calls.length, 2);
    gate.clear('dev');
    await assert.rejects(kc.execAuth.getCredential({ name: 'dev' }));
    assert.equal(calls.length, 3, 'cleared: the helper runs again');
    gate.clear();
    assert.equal(gate.blockedError('dev'), null);
    assert.equal(gate.blockedError('prod'), null);
  });

  test('block(): a user can be stopped without a helper run (signed out)', async () => {
    const gate = createExecGate();
    const { kc, calls } = fakeKubeConfig(() => ({ status: { token: 't' } }));
    gate.attach(kc);
    gate.block('dev', new Error('Signed out of AWS for this cluster.'));
    await assert.rejects(kc.execAuth.getCredential({ name: 'dev' }), { message: 'Signed out of AWS for this cluster.', clusterAuth: true });
    assert.equal(calls.length, 0);
  });

  test('attach is idempotent and tolerates a KubeConfig without exec support', () => {
    const gate = createExecGate();
    const { kc } = fakeKubeConfig(() => null);
    gate.attach(kc);
    const wrapped = kc.execAuth.getCredential;
    gate.attach(kc);
    assert.equal(kc.execAuth.getCredential, wrapped);
    assert.deepEqual(gate.attach({}), {});
    assert.equal(gate.attach(null), null);
  });
});
