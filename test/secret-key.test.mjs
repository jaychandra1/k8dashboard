// electron/secret-key.cjs: the DPAPI-wrapped data key file, exercised with a
// fake safeStorage (the real one exists only inside Electron).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSecretKey } = require('../electron/secret-key.cjs');

// Stand-in for safeStorage: "wraps" by prefixing, so a raw key on disk would show.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`WRAPPED:${Buffer.from(s).toString('hex')}`),
  decryptString: (buf) => {
    const s = buf.toString();
    if (!s.startsWith('WRAPPED:')) throw new Error('decrypt failed');
    return Buffer.from(s.slice(8), 'hex').toString();
  },
});

describe('loadSecretKey', () => {
  let dir, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-key-'));
    file = path.join(dir, 'kubepilot', 'secret.key');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the token helper (create: false) never creates a key', () => {
    assert.equal(loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: false }), null);
    assert.equal(fs.existsSync(file), false);
  });

  test('the GUI creates a 32-byte key once, stored wrapped; later reads return the same key', () => {
    const key = loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: true });
    assert.equal(Buffer.from(key, 'base64').length, 32);
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(onDisk.startsWith('WRAPPED:'));
    assert.ok(!onDisk.includes(key));
    assert.equal(loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: false }), key);
    assert.equal(loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: true }), key);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secret.key']); // no temp files left behind
  });

  test('an unreadable key: the helper gets null; the GUI sets it aside and starts a new one', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage from another machine');
    assert.equal(loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: false }), null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'garbage from another machine');

    const key = loadSecretKey({ file, safeStorage: fakeSafeStorage(), create: true });
    assert.equal(Buffer.from(key, 'base64').length, 32);
    const names = fs.readdirSync(path.dirname(file));
    assert.ok(names.includes('secret.key'));
    assert.ok(names.some((n) => n.startsWith('secret.key.unreadable-')));
  });

  test('no OS encryption available: no key, nothing written (secrets stay as before)', () => {
    assert.equal(loadSecretKey({ file, safeStorage: fakeSafeStorage(false), create: true }), null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(loadSecretKey({ file, safeStorage: undefined, create: true }), null);
  });
});
