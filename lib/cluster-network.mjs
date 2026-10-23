// Why a connection to a cluster's API server failed, and which of its
// endpoints this machine was talking to.
//
// Node's fetch reports every network failure as a bare `TypeError: fetch
// failed`; the real reason (a connect timeout, a refusal, a DNS miss) sits in
// a cause chain — sometimes an AggregateError with one error per address
// tried. And for a managed cluster the same hostname can lead to its private
// endpoint (VPC addresses, reached over Tailscale or a VPN) or its public one,
// depending on this machine's DNS. Knowing which turns "fetch failed" into
// "the cluster's public endpoint didn't answer".
//
// Only categories leave this module — never a hostname or an address.
import dns from 'node:dns';
import net from 'node:net';

const FAILURES = {
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  ECONNREFUSED: 'refused',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_NODATA: 'dns',
  EAI_NONAME: 'dns',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  EHOSTDOWN: 'unreachable',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  UND_ERR_SOCKET: 'reset',
};

/**
 * The network failure behind an error, walking `cause` chains, AggregateError
 * `errors` and WebSocket ErrorEvents (`error`): { code, failure } with failure
 * one of timeout | refused | dns | unreachable | reset — or null when it isn't
 * a network error.
 */
export function networkFailure(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const code = typeof e.code === 'string' ? e.code : undefined;
    if (code && FAILURES[code]) return { code, failure: FAILURES[code] };
    if (e.name === 'TimeoutError') return { code: 'TimeoutError', failure: 'timeout' }; // AbortSignal.timeout()
    if (Array.isArray(e.errors)) queue.push(...e.errors);
    if (e.cause) queue.push(e.cause);
    if (e.error) queue.push(e.error); // ws ErrorEvent (the pod terminal's exec socket)
  }
  return null;
}

/** 'local' | 'private' | 'public' for one IP address. */
export function addressKind(ip) {
  const a = String(ip || '').toLowerCase();
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 127) return 'local';
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return 'private';
    if (x === 100 && y >= 64 && y <= 127) return 'private'; // CGNAT — Tailscale's own range
    if (x === 169 && y === 254) return 'private'; // link-local
    return 'public';
  }
  if (net.isIPv6(a)) {
    if (a === '::1') return 'local';
    if (a.startsWith('::ffff:')) return addressKind(a.slice(7));
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return 'private'; // ULA, link-local
    return 'public';
  }
  return 'public';
}

/**
 * Which endpoint `serverUrl` leads to from this machine: 'local' (loopback),
 * 'private' (every address it resolves to is private — a VPC endpoint),
 * 'public' (any public address) or 'unknown' (unparseable, or DNS failed or
 * took longer than `timeoutMs`).
 */
export async function endpointKind(serverUrl, { lookup = dns.promises.lookup, timeoutMs = 3000 } = {}) {
  let host;
  try {
    host = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';
  if (net.isIP(host)) return addressKind(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  let timer;
  try {
    const addrs = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs); }),
    ]);
    const kinds = new Set((Array.isArray(addrs) ? addrs : []).map((r) => addressKind(r.address)));
    if (kinds.has('public')) return 'public';
    if (kinds.has('private')) return 'private';
    return kinds.has('local') ? 'local' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

const SUBJECT = {
  public: "The cluster's public endpoint",
  private: "The cluster's private endpoint",
  local: 'The cluster API server on this machine',
  unknown: "The cluster's API server",
};
const PREDICATE = {
  timeout: "didn't answer (connection timed out)",
  refused: 'refused the connection',
  unreachable: "can't be reached from this network",
  reset: 'dropped the connection',
};

const SHORT = {
  timeout: 'connection timed out',
  refused: 'connection refused',
  dns: 'DNS lookup failed',
  unreachable: 'network unreachable',
  reset: 'connection dropped',
};

/**
 * A short reason for lists such as "Some kinds could not be loaded:
 * deployments (connection timed out)" — the network failure in words when
 * there is one, else the error's first line.
 */
export function shortReason(error) {
  const network = networkFailure(error);
  if (network) return SHORT[network.failure];
  const msg = String(error?.body?.message || error?.message || error || '');
  return msg.split('\n').map((l) => l.trim()).find(Boolean) || '';
}

/** One plain sentence for the dialog — no hostnames, no addresses. */
export function unreachableMessage({ endpoint = 'unknown', failure } = {}) {
  if (failure === 'dns') return "The cluster's address could not be found (DNS lookup failed).";
  return `${SUBJECT[endpoint] || SUBJECT.unknown} ${PREDICATE[failure] || "can't be reached"}.`;
}
