// lib/secret-store.mjs takes the at-rest key from K8BOARD_SECRET_KEY (the name
// electron/main.cjs sets), falling back to the name from before the rename,
// and removes every spelling from the environment once read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.K8BOARD_SECRET_KEY = crypto.randomBytes(32).toString('base64');
process.env.KUBEPILOT_SECRET_KEY = 'not-a-valid-key'; // must not win over K8BOARD_
process.env.K8BOARD_SECRET_SCOPE = 'llm';
process.env.KUBEPILOT_SECRET_SCOPE = 'llm,azure';
const store = await import('../lib/secret-store.mjs');

test('K8BOARD_SECRET_KEY is the key; every spelling leaves the environment', () => {
  assert.equal(store.encryptionEnabled(), true);
  for (const name of ['K8BOARD_SECRET_KEY', 'KUBEPILOT_SECRET_KEY', 'K8BOARD_SECRET_SCOPE', 'KUBEPILOT_SECRET_SCOPE']) {
    assert.equal(process.env[name], undefined, name);
  }
});
