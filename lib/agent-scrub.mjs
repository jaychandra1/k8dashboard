// What an AI agent (the MCP principal) gets back from the routes that return
// free text or arbitrary object data: pod logs, events, Helm values and
// manifests, custom resources, Argo CD objects and object YAML (audit SEC-03).
//
// Unless the user lets agents read secret values (Preferences → MCP → "Secret
// values"), credentials are masked the way the built-in assistant masks what it
// sends to its LLM provider:
//   - Kubernetes Secret objects anywhere in the data keep their keys, not their values;
//   - a field named like a credential (password, token, apiKey, clientSecret…)
//     loses its value, unless the name only points at one (secretName,
//     passwordFile, tokenSecretRef, existingSecret…);
//   - an env-style { name, value } pair with a secret-looking name loses its value;
//   - every other string goes through redactSecretsInText (private keys, JWTs,
//     Authorization headers, passwords in URLs, cloud and SaaS keys,
//     `password=…` assignments);
//   - JSON held in a string (e.g. the last-applied-configuration annotation)
//     and YAML text (Helm values and manifests, object YAML) are parsed and
//     treated the same way; text that doesn't parse gets the text scrub.
// The input is never changed: a response may be an object from the shared cache.
import yaml from './yaml.mjs';
import { redactSecretsInText } from './redact-secrets.mjs';

// The structural mask assistant.js redactSecret writes (the text scrubber writes "[redacted]").
export const MASK = '<redacted>';

const CREDENTIAL_KEY = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key/i;
// Names that point at a credential (or describe one) rather than hold it.
const REFERENCE_KEY = /(?:name|names|ref|refs|path|file|files|namespace|ttl|seconds|type|enabled|existing\w*)$|^existing/i;
const SECRET_ENV_NAME = /PASS|PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE/i;
const MAX_DEPTH = 64;
const MAX_NESTED_TEXT = 1024 * 1024; // JSON / YAML parsed out of a string, at most

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v);

/** Does a field called `key` hold a credential (rather than name or point at one)? */
export const isCredentialKey = (key) => typeof key === 'string' && CREDENTIAL_KEY.test(key) && !REFERENCE_KEY.test(key);

function scrubString(text, depth) {
  const t = text.trimStart();
  if ((t.startsWith('{') || t.startsWith('[')) && text.length <= MAX_NESTED_TEXT) {
    try {
      return JSON.stringify(scrubValue(JSON.parse(text), depth + 1));
    } catch { /* not JSON: plain text */ }
  }
  return redactSecretsInText(text);
}

function scrubValue(value, depth = 0, key) {
  if (depth > MAX_DEPTH) return MASK;
  if (typeof value === 'string') {
    if (key !== undefined && isCredentialKey(key) && value !== '') return MASK;
    return scrubString(value, depth);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, depth + 1, k);

  if (value.kind === 'Secret') {
    for (const field of ['data', 'stringData']) {
      if (isPlainObject(value[field])) out[field] = Object.fromEntries(Object.keys(value[field]).map((k) => [k, MASK]));
    }
  }
  // env: [{ name: DB_PASSWORD, value: … }] and the like.
  if (typeof value.name === 'string' && typeof value.value === 'string' && SECRET_ENV_NAME.test(value.name)) out.value = MASK;
  return out;
}

/** A copy of `body` (any JSON value) with credentials masked. */
export function scrubForAgent(body) {
  return scrubValue(body);
}

/**
 * YAML text (one or more documents) with credentials masked. Each document's
 * leading comments (Helm's "# Source: chart/templates/x.yaml") are kept. Text
 * that isn't YAML gets the text scrub.
 */
export function scrubYamlForAgent(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  if (text.length > MAX_NESTED_TEXT * 8) return redactSecretsInText(text);
  try {
    const chunks = text.split(/^---[ \t]*(?:#.*)?$/m);
    const out = chunks.map((chunk) => {
      const lines = chunk.replace(/^\r?\n/, '').split(/\r?\n/);
      let i = 0;
      while (i < lines.length && /^\s*(?:#.*)?$/.test(lines[i])) i++;
      const comments = lines.slice(0, i).filter((l) => l.trim()).join('\n');
      if (i === lines.length) return comments ? `${comments}\n` : ''; // comments only (js-yaml refuses an empty document)
      const doc = yaml.load(chunk);
      if (doc === undefined || doc === null) return comments ? `${comments}\n` : '';
      const body = typeof doc === 'object' ? yaml.dump(scrubValue(doc), { lineWidth: -1 }) : `${scrubString(String(doc), 0)}\n`;
      return comments ? `${comments}\n${body}` : body;
    }).filter(Boolean);
    return out.join('---\n');
  } catch {
    return redactSecretsInText(text);
  }
}

/** Response bodies: objects get scrubForAgent, `yaml` text fields the YAML treatment. */
export function scrubResponseForAgent(body) {
  if (!isPlainObject(body)) return scrubForAgent(body);
  const out = scrubForAgent({ ...body, yaml: undefined });
  if (typeof body.yaml === 'string') out.yaml = scrubYamlForAgent(body.yaml);
  else if ('yaml' in body) out.yaml = scrubForAgent(body.yaml);
  else delete out.yaml;
  return out;
}
