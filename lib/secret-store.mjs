// At-rest protection for the app's own long-lived secrets: the Azure AD
// refresh token (azure-auth.json) and the AI provider API key (config.json).
//
// Desktop app on Windows: values are sealed with AES-256-GCM under a per-user
// data key. The key itself lives in ~/.config/kubepilot/secret.key, wrapped by
// Electron's safeStorage (Windows DPAPI), so a copied or synced file is useless
// on another machine or account. electron/main.cjs unwraps it and hands it to
// the backend and to the Azure token helper through KUBEPILOT_SECRET_KEY.
//
// The variable is read once when this module loads and then REMOVED from
// process.env, so nothing the backend spawns later (kubectl, az, trivy, pod
// and AI-agent terminals) inherits it.
//
// KUBEPILOT_SECRET_SCOPE (optional, comma list: "llm", "azure") limits which
// secrets are sealed. The desktop app seals the Azure refresh token only once
// it has verified that the separate token-helper process can open it; until
// then a sealed token is re-saved in plaintext, so AKS logins never break.
// Unset = every secret (e.g. a server run given its own key).
//
// No key (dev `node server.js`, Docker, macOS/Linux where 0600 file modes
// already protect these files): seal() returns the value unchanged, exactly
// the behaviour of earlier versions. Plaintext values written by earlier
// versions are always readable; callers re-save them sealed when a key exists.
import crypto from 'crypto';

export const SECRET_KEY_ENV = 'KUBEPILOT_SECRET_KEY';
// Additional authenticated data per field: a sealed value only opens in the
// field it was written for.
export const PURPOSE = Object.freeze({ azureRefreshToken: 'azure.refreshToken', llmApiKey: 'llm.apiKey' });
const ALG = 'aes-256-gcm';

export const SECRET_SCOPE_ENV = 'KUBEPILOT_SECRET_SCOPE';

let key = null;
let scopes = null; // null → every purpose
{
  const raw = process.env[SECRET_KEY_ENV];
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) key = buf;
    delete process.env[SECRET_KEY_ENV];
  }
  const scope = process.env[SECRET_SCOPE_ENV];
  if (scope !== undefined) {
    scopes = new Set(String(scope).split(',').map((s) => s.trim()).filter(Boolean));
    delete process.env[SECRET_SCOPE_ENV];
  }
}
const scopeOf = (purpose) => String(purpose).split('.')[0];

/** True when a key is available in this process. */
export const encryptionEnabled = () => key !== null;

/** True when values for `purpose` are sealed when written. */
export const sealingEnabled = (purpose) => key !== null && (scopes === null || scopes.has(scopeOf(purpose)));

/** Is `v` a sealed envelope (as opposed to a legacy plaintext string)? */
export const isSealed = (v) => !!v && typeof v === 'object' && v.kpEnc === 1 && typeof v.data === 'string';

/**
 * Seal `plain` for storage. `purpose` is bound as additional authenticated
 * data, so a sealed value cannot be moved to a different field and still
 * decrypt. Without a key the plaintext is returned unchanged.
 */
export function seal(plain, purpose) {
  if (plain == null || plain === '' || !sealingEnabled(purpose)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(String(purpose), 'utf8'));
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { kpEnc: 1, alg: ALG, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/**
 * The plaintext of a stored value: legacy strings pass through; sealed values
 * are decrypted. Returns null when a sealed value cannot be opened (no key in
 * this process, a different key, or tampering) — callers treat that as
 * "not signed in / not configured".
 */
export function unseal(stored, purpose) {
  if (typeof stored === 'string') return stored;
  if (!isSealed(stored) || !key) return null;
  try {
    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(stored.iv, 'base64'));
    decipher.setAAD(Buffer.from(String(purpose), 'utf8'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A plaintext value that should be re-saved sealed. */
export const needsSealing = (stored, purpose) => sealingEnabled(purpose) && typeof stored === 'string' && stored !== '';

/** A sealed value this process can open that should be re-saved in plaintext (its scope is off). */
export const needsUnsealing = (stored, purpose) => key !== null && !sealingEnabled(purpose) && isSealed(stored);
