// Masking for values that identify a customer's environment, used wherever the
// UI shows cloud / cluster details (the startup connection dialog, sign-in).
// The real values still flow to the server and to copy-to-run commands; only
// what is displayed is masked.

const DOTS = '••••';

/** "241533118296" → "••••8296" (anything that isn't 12 digits is returned as is). */
export const maskAccountId = (id) => (/^\d{12}$/.test(String(id || '')) ? `${DOTS}${String(id).slice(-4)}` : id);

// Public documentation hosts that may appear in error text and are safe to show.
const PUBLIC_HOSTS = /^(?:[a-z0-9-]+\.)*(?:kubernetes\.io|k8s\.io|docs\.aws\.amazon\.com|aws\.amazon\.com|learn\.microsoft\.com|aka\.ms|cloud\.google\.com|github\.com|helm\.sh)$/i;

/**
 * Mask environment identifiers in free text (error messages, commands):
 * AWS account ids (alone or inside ARNs / profile names), AWS access-portal,
 * EKS / AKS / GKE endpoint hosts, other URL hosts, IPv4 addresses, GUIDs
 * (tenant / subscription ids) and bearer tokens.
 */
export function redactSensitive(text) {
  if (text == null) return text;
  let s = String(text);
  // Tokens first (they can contain digit runs).
  s = s.replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g, '[token]');
  s = s.replace(/\bk8s-aws-v1\.[\w-]+/g, '[token]');
  s = s.replace(/\b(Bearer)\s+[\w.~+/-]{16,}=*/gi, '$1 [token]');
  s = s.replace(/(\btoken["']?\s*[=:]\s*["']?)[\w.~+/-]{16,}=*/gi, '$1[token]');
  // Hosts that embed an identifier.
  s = s.replace(/\b[a-z0-9-]+\.awsapps\.com\b/gi, `${DOTS}.awsapps.com`);
  s = s.replace(/\b[0-9a-f]{32}\.[a-z0-9]+\.([a-z]{2}(?:-[a-z]+)+-\d)\.eks\.amazonaws\.com\b/gi, `${DOTS}.$1.eks.amazonaws.com`);
  s = s.replace(/\b[a-z0-9-]+\.(?:hcp\.|privatelink\.)?([a-z0-9-]+)\.azmk8s\.io\b/gi, `${DOTS}.$1.azmk8s.io`);
  // Any other URL host (cluster API servers, internal endpoints), keeping public docs links.
  s = s.replace(/\b(https?:\/\/)([^\s/:"'<>)]+)/gi, (m, scheme, host) => (PUBLIC_HOSTS.test(host) || host.startsWith(DOTS) ? m : `${scheme}${DOTS}`));
  // GUIDs (Azure tenant / subscription / client ids).
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})\b/gi, `${DOTS}$1`);
  // IPv4 addresses.
  s = s.replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, 'x.x.x.x');
  // 12-digit AWS account ids, also inside ARNs and names like "sso-241533118296".
  s = s.replace(/(^|[^\d])(\d{8})(\d{4})(?!\d)/g, (m, pre, head, tail) => (head.length === 8 ? `${pre}${DOTS}${tail}` : m));
  return s;
}
