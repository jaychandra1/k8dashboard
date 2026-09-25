// The per-user data key that lib/secret-store.mjs seals secrets with.
//
// Stored in ~/.config/kubepilot/secret.key as safeStorage.encryptString(base64
// key): on Windows that is DPAPI, bound to this user account on this machine.
// Only the GUI creates the key (once, before the backend starts); the
// `--token-helper azure` path only reads it, so two processes can never race
// to create different keys.
//
// Kept free of `require('electron')` so it can be unit-tested with a fake
// safeStorage (test/secret-key.test.mjs).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Base64 of the 32-byte data key, or null when encryption isn't available.
 *
 * @param {object} o
 * @param {string} o.file         path of the wrapped key file
 * @param {object} o.safeStorage  { isEncryptionAvailable(), encryptString(s), decryptString(buf) }
 * @param {boolean} o.create      create the key when missing (GUI only)
 * @param {(msg: string) => void} [o.warn]
 */
function loadSecretKey({ file, safeStorage, create, warn = () => {} }) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
  } catch {
    return null;
  }

  if (fs.existsSync(file)) {
    try {
      const b64 = safeStorage.decryptString(fs.readFileSync(file));
      if (Buffer.from(b64, 'base64').length === 32) return b64;
      throw new Error('unexpected key length');
    } catch (err) {
      // Unreadable: the profile was copied to another machine/account, or the
      // file is damaged. Secrets sealed with the old key can't be opened any
      // more (the user signs in again). Keep the file aside rather than delete it.
      if (!create) return null;
      warn(`secret key unreadable (${err.message}); starting a new one`);
      try { fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch { /* ignore */ }
    }
  } else if (!create) {
    return null;
  }

  const b64 = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(b64), { mode: 0o600 });
    try {
      // Create-if-absent: never replace a key another process wrote meanwhile.
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        fs.unlinkSync(tmp);
        return loadSecretKey({ file, safeStorage, create: false, warn });
      }
      fs.renameSync(tmp, file); // filesystems without hard links
      return b64;
    }
    fs.unlinkSync(tmp);
    return b64;
  } catch (err) {
    warn(`could not store the secret key (${err.message}); secrets stay unencrypted this session`);
    return null;
  }
}

module.exports = { loadSecretKey };
