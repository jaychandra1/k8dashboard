// Desktop app before (or without) a verified token helper: the backend gets
// the key with KUBEPILOT_SECRET_SCOPE=llm. The AI key is sealed; an Azure
// refresh token that is sealed on disk is re-saved in plaintext so the
// separate `--token-helper azure` process can keep using it. Own process
// (node --test isolates files), temp HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-scope-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const cfgDir = path.join(home, '.config', 'kubepilot');
const authFile = path.join(cfgDir, 'azure-auth.json');
const configFile = path.join(cfgDir, 'config.json');
fs.mkdirSync(cfgDir, { recursive: true });

const KEY = crypto.randomBytes(32).toString('base64');
// A token sealed earlier (sealing was on) with the same key.
process.env.KUBEPILOT_SECRET_KEY = KEY;
const writer = await import('../lib/secret-store.mjs?writer');
fs.writeFileSync(authFile, JSON.stringify({ refreshToken: writer.seal('sealed-refresh-token', writer.PURPOSE.azureRefreshToken), tenant: 'tenant-1' }));
fs.writeFileSync(configFile, JSON.stringify({ llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-plain', model: 'm' } }));

// Now start the backend modules as the desktop app would before verification.
process.env.KUBEPILOT_SECRET_KEY = KEY;
process.env.KUBEPILOT_SECRET_SCOPE = 'llm';
const store = await import('../lib/secret-store.mjs');
await import('../azure-aks.js');
const assistant = await import('../assistant.js');

after(() => { fs.rmSync(home, { recursive: true, force: true }); });

test('the sealed Azure token is re-saved in plaintext so the token helper can use it', () => {
  const onDisk = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(onDisk.refreshToken, 'sealed-refresh-token');
  assert.equal(onDisk.tenant, 'tenant-1');
});

test('the AI key is still sealed (only the backend reads it)', () => {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(store.isSealed(cfg.llm.apiKey), true);
  assert.equal(assistant.loadStoredLlm().apiKey, 'sk-plain');
});

test('neither variable stays in the environment', () => {
  assert.equal(process.env.KUBEPILOT_SECRET_KEY, undefined);
  assert.equal(process.env.KUBEPILOT_SECRET_SCOPE, undefined);
});
