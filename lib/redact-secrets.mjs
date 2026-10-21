// Credential scrubbing for free text that leaves the machine — pod logs,
// events, ConfigMap data and object YAML sent to the AI assistant's LLM.
//
// Secret objects and secret-looking env values are already masked
// structurally (assistant.js redactSecret); this catches credentials that
// applications print or store as plain text: private keys, JWTs, bearer and
// basic auth headers, cloud/SaaS API keys, passwords in connection strings, and
// `password=…` / `"apiKey": "…"`-style assignments. It errs on the side of
// masking; the surrounding text stays readable for debugging.
const R = '[redacted]';

const PATTERNS = [
  // PEM private keys (RSA, EC, OPENSSH, PKCS#8, encrypted…), whole block.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, `[redacted private key]`],
  // JSON Web Tokens (incl. Kubernetes service-account tokens).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${R}`],
  // Passwords in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`],
  // Well-known key formats.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, R], // AWS access key id
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, R], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R], // Slack
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R], // Google API key
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, R], // Stripe
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, R], // OpenAI / Anthropic style
  // key = value / "key": "value" where the key names a credential.
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&}]{3,})/gi,
    (m, key, sep, value) => (value === R || value.startsWith('[redacted') ? m : `${key}${sep}${R}`),
  ],
];

/** `text` with credentials replaced by "[redacted]". Non-strings are returned as is. */
export function redactSecretsInText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
