// "Could not connect to the cluster": which network failure it was (fetch
// hides it behind "fetch failed") and whether this machine reached the
// cluster's private or public endpoint — categories only, never addresses.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { addressKind, endpointKind, networkFailure, shortReason, unreachableMessage } from '../lib/cluster-network.mjs';
import { startServer } from './helpers/server.mjs';

const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });

describe('networkFailure', () => {
  test('finds the code behind "fetch failed": undici, errno, AggregateError, AbortSignal timeouts', () => {
    assert.deepEqual(networkFailure(fetchFailed({ code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' })), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
      failure: 'timeout',
    });
    assert.equal(networkFailure(fetchFailed({ code: 'ECONNREFUSED' })).failure, 'refused');
    assert.equal(networkFailure(fetchFailed({ code: 'ENOTFOUND' })).failure, 'dns');
    assert.equal(networkFailure(fetchFailed({ code: 'EHOSTUNREACH' })).failure, 'unreachable');
    assert.equal(networkFailure(fetchFailed({ code: 'UND_ERR_SOCKET' })).failure, 'reset');
    const agg = Object.assign(new AggregateError([{ code: 'ETIMEDOUT' }, { code: 'ETIMEDOUT' }]), {});
    assert.equal(networkFailure(fetchFailed(agg)).failure, 'timeout');
    const deep = fetchFailed({ message: 'wrapped', cause: { cause: { code: 'ENETUNREACH' } } });
    assert.equal(networkFailure(deep).failure, 'unreachable');
    assert.equal(networkFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })).failure, 'timeout');
    // ws hands out an ErrorEvent whose original error sits under `.error`.
    assert.equal(networkFailure({ type: 'error', message: 'connect ECONNREFUSED', error: { code: 'ECONNREFUSED' } }).failure, 'refused');
  });

  test('shortReason: network failures in words, otherwise the first line of the error', () => {
    assert.equal(shortReason(fetchFailed({ code: 'UND_ERR_CONNECT_TIMEOUT' })), 'connection timed out');
    assert.equal(shortReason(fetchFailed({ code: 'ENOTFOUND' })), 'DNS lookup failed');
    assert.equal(shortReason({ body: { message: 'deployments.apps is forbidden: User "x"\ncannot list' } }), 'deployments.apps is forbidden: User "x"');
    assert.equal(shortReason(new Error('\n  boom  \nmore')), 'boom');
  });

  test('anything else is not a network failure', () => {
    assert.equal(networkFailure(new Error('Unauthorized')), null);
    assert.equal(networkFailure(Object.assign(new Error('HTTP 401'), { code: 401 })), null);
    assert.equal(networkFailure(fetchFailed({ code: 'CERT_HAS_EXPIRED' })), null);
    assert.equal(networkFailure(null), null);
    const loop = { code: 'X' };
    loop.cause = loop;
    assert.equal(networkFailure(loop), null, 'cause cycles terminate');
  });
});

describe('endpointKind', () => {
  const lookupOf = (...ips) => async () => ips.map((address) => ({ address }));

  test('addresses: loopback, private (RFC 1918, Tailscale CGNAT, ULA) and public', () => {
    for (const ip of ['127.0.0.1', '::1']) assert.equal(addressKind(ip), 'local', ip);
    for (const ip of ['10.24.30.223', '172.16.0.1', '172.31.255.1', '192.168.1.5', '100.74.112.116', 'fd7a:115c:a1e0::1', '::ffff:10.0.0.1']) {
      assert.equal(addressKind(ip), 'private', ip);
    }
    for (const ip of ['18.200.1.18', '172.32.0.1', '100.128.0.1', '2600:1f18::1']) assert.equal(addressKind(ip), 'public', ip);
  });

  test("an EKS hostname is private when every address is a VPC address, public when any is public", async () => {
    const eks = 'https://49B8A64035E12DFA22A9C44C3ABF0985.gr7.eu-west-1.eks.amazonaws.com';
    assert.equal(await endpointKind(eks, { lookup: lookupOf('10.0.1.63', '10.0.2.185') }), 'private');
    assert.equal(await endpointKind(eks, { lookup: lookupOf('18.200.1.18', '54.1.2.43') }), 'public');
    assert.equal(await endpointKind(eks, { lookup: lookupOf('10.0.1.63', '54.1.2.43') }), 'public');
  });

  test('IP literals and localhost need no DNS; failures and slow DNS are "unknown"', async () => {
    const never = async () => { throw new Error('lookup must not run'); };
    assert.equal(await endpointKind('https://10.0.0.1:6443', { lookup: never }), 'private');
    assert.equal(await endpointKind('https://[::1]:6443', { lookup: never }), 'local');
    assert.equal(await endpointKind('https://localhost:6443', { lookup: never }), 'local');
    assert.equal(await endpointKind('https://x.example', { lookup: async () => { throw Object.assign(new Error('nf'), { code: 'ENOTFOUND' }); } }), 'unknown');
    const slow = () => new Promise((r) => setTimeout(() => r([{ address: '1.1.1.1' }]), 500));
    assert.equal(await endpointKind('https://x.example', { lookup: slow, timeoutMs: 20 }), 'unknown');
    assert.equal(await endpointKind('not a url'), 'unknown');
  });

  test('messages name the endpoint and the failure, never an address', () => {
    assert.equal(unreachableMessage({ endpoint: 'public', failure: 'timeout' }), "The cluster's public endpoint didn't answer (connection timed out).");
    assert.equal(unreachableMessage({ endpoint: 'private', failure: 'timeout' }), "The cluster's private endpoint didn't answer (connection timed out).");
    assert.equal(unreachableMessage({ endpoint: 'local', failure: 'refused' }), 'The cluster API server on this machine refused the connection.');
    assert.equal(unreachableMessage({ failure: 'dns' }), "The cluster's address could not be found (DNS lookup failed).");
    assert.equal(unreachableMessage({}), "The cluster's API server can't be reached.");
  });
});

describe('/api/config/auth reports an unreachable cluster with its endpoint kind', () => {
  let srv, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-net-'));
    const kubeconfig = path.join(dir, 'config');
    // A loopback port nobody listens on: refused at once, no network needed.
    // (Not a well-known port — fetch refuses "bad ports" such as 1 before connecting.)
    const closed = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
    fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'https://127.0.0.1:${closed}', insecure-skip-tls-verify: true }
users:
- name: dev
  user: { token: dev-token }
contexts:
- name: dev
  context: { cluster: dev, user: dev }
`);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig } });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refused on loopback → unreachable, local endpoint, plain message, code in the detail', async () => {
    const auth = await (await srv.authed('/api/config/auth')).json();
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'unreachable');
    assert.deepEqual(auth.network, { failure: 'refused', endpoint: 'local' });
    assert.equal(auth.message, 'The cluster API server on this machine refused the connection.');
    assert.match(auth.detail, /\(ECONNREFUSED\)$/);
  });
});
