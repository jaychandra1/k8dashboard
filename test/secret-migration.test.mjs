// Upgrade path on the Windows desktop app: the Azure refresh token and the AI
// provider API key saved in plaintext by earlier versions are re-saved sealed,
// and everything keeps working. Runs in its own process (node --test isolates
// files) with HOME pointed at a temp dir and the data key in the environment,
// as electron/main.cjs provides it.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-secrets-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const cfgDir = path.join(home, '.config', 'kubepilot');
const authFile = path.join(cfgDir, 'azure-auth.json');
const configFile = path.join(cfgDir, 'config.json');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(authFile, JSON.stringify({ refreshToken: 'legacy-refresh-token', tenant: 'tenant-1', account: 'dev@example.com' }));
fs.writeFileSync(configFile, JSON.stringify({ llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-legacy-key', model: 'model-x' }, other: { keep: true } }));

process.env.KUBEPILOT_SECRET_KEY = crypto.randomBytes(32).toString('base64');
const store = await import('../lib/secret-store.mjs');
await import('../azure-aks.js'); // re-saves a plaintext refresh token sealed on load
const azureToken = await import('../azure-token.js');
const assistant = await import('../assistant.js'); // re-saves a plaintext API key sealed on load

const raw = (file) => fs.readFileSync(file, 'utf8');

after(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('Azure refresh token at rest', () => {
  test('a plaintext token from an earlier version is re-saved sealed; other fields are kept', () => {
    const text = raw(authFile);
    assert.ok(!text.includes('legacy-refresh-token'));
    const onDisk = JSON.parse(text);
    assert.equal(store.isSealed(onDisk.refreshToken), true);
    assert.equal(onDisk.tenant, 'tenant-1');
    assert.equal(onDisk.account, 'dev@example.com');
  });

  test('the token helper still reads it, and a rotated token is saved sealed', () => {
    const { store: authStore, refreshToken } = azureToken.readStoredRefreshToken();
    assert.equal(refreshToken, 'legacy-refresh-token');
    azureToken.saveRefreshToken(authStore, 'rotated-refresh-token');
    assert.ok(!raw(authFile).includes('rotated-refresh-token'));
    assert.equal(azureToken.readStoredRefreshToken().refreshToken, 'rotated-refresh-token');
  });

  test('a token sealed on another machine or account asks the user to sign in again', async () => {
    process.env.KUBEPILOT_SECRET_KEY = crypto.randomBytes(32).toString('base64');
    const other = await import('../lib/secret-store.mjs?other-machine');
    fs.writeFileSync(authFile, JSON.stringify({ refreshToken: other.seal('x', other.PURPOSE.azureRefreshToken), tenant: 'tenant-1' }));
    assert.throws(() => azureToken.readStoredRefreshToken(), /can't be opened on this machine or account/);
  });

  test('no saved sign-in still gives the usual message', () => {
    fs.rmSync(authFile);
    assert.throws(() => azureToken.readStoredRefreshToken(), /Not signed in to Azure/);
  });
});

describe('AI provider API key at rest', () => {
  test('a plaintext key from an earlier version is re-saved sealed; the rest of config.json is kept', () => {
    const text = raw(configFile);
    assert.ok(!text.includes('sk-legacy-key'));
    const cfg = JSON.parse(text);
    assert.equal(store.isSealed(cfg.llm.apiKey), true);
    assert.equal(cfg.llm.baseUrl, 'https://llm.example/v1');
    assert.equal(cfg.llm.model, 'model-x');
    assert.deepEqual(cfg.other, { keep: true });
  });

  test('the assistant still loads the key in plaintext (in memory only)', () => {
    assert.deepEqual(assistant.loadStoredLlm(), { baseUrl: 'https://llm.example/v1', apiKey: 'sk-legacy-key', model: 'model-x' });
  });
});

test('the data key never stays in the environment (child processes cannot inherit it)', () => {
  assert.equal(process.env.KUBEPILOT_SECRET_KEY, undefined);
});
