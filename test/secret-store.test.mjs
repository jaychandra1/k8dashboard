// lib/secret-store.mjs: AES-256-GCM sealing of the app's own secrets. Each
// import below uses a distinct query string so it gets a fresh module
// instance that reads KUBEPILOT_SECRET_KEY as set at that moment.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const KEY = crypto.randomBytes(32).toString('base64');
let n = 0;
async function load(envKey, scope) {
  if (envKey === undefined) delete process.env.KUBEPILOT_SECRET_KEY;
  else process.env.KUBEPILOT_SECRET_KEY = envKey;
  if (scope === undefined) delete process.env.KUBEPILOT_SECRET_SCOPE;
  else process.env.KUBEPILOT_SECRET_SCOPE = scope;
  n += 1;
  return import(`../lib/secret-store.mjs?instance=${n}`);
}

describe('secret-store with a key (Windows desktop app)', () => {
  test('reads the key once and removes it from process.env, so child processes never inherit it', async () => {
    const s = await load(KEY);
    assert.equal(s.encryptionEnabled(), true);
    assert.equal(process.env.KUBEPILOT_SECRET_KEY, undefined);
  });

  test('seal/unseal round-trips; the envelope never contains the plaintext', async () => {
    const s = await load(KEY);
    const secret = '0.AXoA-refresh-token-value';
    const sealed = s.seal(secret, s.PURPOSE.azureRefreshToken);
    assert.equal(s.isSealed(sealed), true);
    assert.equal(sealed.alg, 'aes-256-gcm');
    assert.ok(!JSON.stringify(sealed).includes(secret));
    assert.equal(s.unseal(sealed, s.PURPOSE.azureRefreshToken), secret);
    // A fresh IV every time: sealing twice gives different ciphertext.
    assert.notEqual(s.seal(secret, s.PURPOSE.azureRefreshToken).data, sealed.data);
  });

  test('a value only opens in the field it was sealed for, and tampering is detected', async () => {
    const s = await load(KEY);
    const sealed = s.seal('sk-live-123', s.PURPOSE.llmApiKey);
    assert.equal(s.unseal(sealed, s.PURPOSE.azureRefreshToken), null);
    const flipped = Buffer.from(sealed.data, 'base64');
    flipped[0] ^= 1;
    assert.equal(s.unseal({ ...sealed, data: flipped.toString('base64') }, s.PURPOSE.llmApiKey), null);
  });

  test('legacy plaintext still reads, and is flagged for re-saving sealed', async () => {
    const s = await load(KEY);
    assert.equal(s.unseal('plain-token', s.PURPOSE.azureRefreshToken), 'plain-token');
    assert.equal(s.needsSealing('plain-token', s.PURPOSE.azureRefreshToken), true);
    assert.equal(s.needsSealing(s.seal('x', s.PURPOSE.llmApiKey), s.PURPOSE.llmApiKey), false);
    assert.equal(s.needsSealing('', s.PURPOSE.llmApiKey), false);
    assert.equal(s.unseal(undefined, s.PURPOSE.llmApiKey), null);
  });

  test('a value sealed under another key does not open', async () => {
    const other = await load(crypto.randomBytes(32).toString('base64'));
    const sealed = other.seal('secret', other.PURPOSE.llmApiKey);
    const s = await load(KEY);
    assert.equal(s.unseal(sealed, s.PURPOSE.llmApiKey), null);
  });
});

describe('secret-store without a key (dev, Docker, macOS/Linux)', () => {
  test('values stay plaintext, exactly as earlier versions wrote them', async () => {
    const s = await load(undefined);
    assert.equal(s.encryptionEnabled(), false);
    assert.equal(s.seal('plain', s.PURPOSE.llmApiKey), 'plain');
    assert.equal(s.unseal('plain', s.PURPOSE.llmApiKey), 'plain');
    assert.equal(s.needsSealing('plain', s.PURPOSE.llmApiKey), false);
  });

  test('a sealed value from the desktop app reads as absent (callers ask to sign in again)', async () => {
    const withKey = await load(KEY);
    const sealed = withKey.seal('secret', withKey.PURPOSE.azureRefreshToken);
    const s = await load(undefined);
    assert.equal(s.unseal(sealed, s.PURPOSE.azureRefreshToken), null);
  });

  test('a malformed key is ignored (and still removed from the environment)', async () => {
    const s = await load(crypto.randomBytes(16).toString('base64'));
    assert.equal(s.encryptionEnabled(), false);
    assert.equal(process.env.KUBEPILOT_SECRET_KEY, undefined);
  });
});

describe('secret-store scopes (desktop app before the token helper is verified)', () => {
  test('only the listed scopes are sealed; the scope variable is removed from the environment', async () => {
    const s = await load(KEY, 'llm');
    assert.equal(process.env.KUBEPILOT_SECRET_SCOPE, undefined);
    assert.equal(s.sealingEnabled(s.PURPOSE.llmApiKey), true);
    assert.equal(s.sealingEnabled(s.PURPOSE.azureRefreshToken), false);
    assert.equal(s.isSealed(s.seal('k', s.PURPOSE.llmApiKey)), true);
    assert.equal(s.seal('rt', s.PURPOSE.azureRefreshToken), 'rt');
    assert.equal(s.needsSealing('rt', s.PURPOSE.azureRefreshToken), false);
  });

  test('a sealed value outside the scopes still opens, and is flagged for re-saving in plaintext', async () => {
    const all = await load(KEY);
    const sealed = all.seal('rt', all.PURPOSE.azureRefreshToken);
    const s = await load(KEY, 'llm');
    assert.equal(s.unseal(sealed, s.PURPOSE.azureRefreshToken), 'rt');
    assert.equal(s.needsUnsealing(sealed, s.PURPOSE.azureRefreshToken), true);
    assert.equal(s.needsUnsealing(sealed, s.PURPOSE.llmApiKey), false);
    assert.equal(all.needsUnsealing(sealed, all.PURPOSE.azureRefreshToken), false);
  });
});
