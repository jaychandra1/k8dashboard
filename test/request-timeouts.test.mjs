// Audit REL-02: Kubernetes and cloud calls are bounded. Every typed
// Kubernetes client gets a default timeout unless the call sets its own, AWS
// SDK clients fail a request that passes their requestTimeout, and Azure
// fetches carry an AbortSignal.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as k8s from '@kubernetes/client-node';
import { EKSClient } from '@aws-sdk/client-eks';
import { SSOOIDCClient } from '@aws-sdk/client-sso-oidc';
import { withDefaultTimeout, requestOptions } from '../lib/k8s-ops.mjs';
import { awsRequestHandler, cloudSignal, CLOUD_REQUEST_TIMEOUT_MS } from '../lib/net-timeouts.mjs';

describe('withDefaultTimeout (typed Kubernetes clients)', () => {
  let api, sockets;
  const delays = { '/api/v1/namespaces': 60_000, '/api/v1/nodes': 400 };

  before(async () => {
    sockets = new Set();
    api = http.createServer((req, res) => {
      const ms = delays[req.url.split('?')[0]] ?? 0;
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ kind: 'List', apiVersion: 'v1', metadata: {}, items: [] }));
      }, ms);
      res.on('close', () => clearTimeout(timer));
    });
    api.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
  });
  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => api.close(r));
  });

  const kubeConfig = () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'c', server: `http://127.0.0.1:${api.address().port}`, skipTLSVerify: true }],
      users: [{ name: 'u', token: 't' }],
      contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
      currentContext: 'x',
    });
    return kc;
  };

  test('a hung API server fails the call after the default timeout', async () => {
    const core = withDefaultTimeout(kubeConfig(), 150).makeApiClient(k8s.CoreV1Api);
    const started = Date.now();
    await assert.rejects(core.listNamespace());
    const took = Date.now() - started;
    assert.ok(took >= 100 && took < 5000, `failed after ${took} ms`);
  });

  test("a call's own requestOptions timeout wins over the default", async () => {
    const core = withDefaultTimeout(kubeConfig(), 150).makeApiClient(k8s.CoreV1Api);
    // /api/v1/nodes answers after 400 ms: past the default, within the call's 5 s.
    const list = await core.listNode({}, requestOptions(5000));
    assert.deepEqual(list.items, []);
    await assert.rejects(core.listNode(), 'without its own options the default applies');
  });

  test('applies once per KubeConfig; leaves anything without makeApiClient alone', () => {
    const kc = withDefaultTimeout(kubeConfig(), 150);
    const make = kc.makeApiClient;
    assert.equal(withDefaultTimeout(kc), kc);
    assert.equal(kc.makeApiClient, make);
    assert.equal(withDefaultTimeout(null), null);
    assert.deepEqual(withDefaultTimeout({}), {});
  });
});

describe('cloud call bounds', () => {
  test('AWS SDK clients resolve the request handler limits and throw on timeout', async () => {
    for (const Client of [EKSClient, SSOOIDCClient]) {
      const client = new Client({ region: 'us-east-1', requestHandler: awsRequestHandler() });
      const cfg = await client.config.requestHandler.configProvider;
      assert.deepEqual(
        [cfg.requestTimeout, cfg.connectionTimeout, cfg.throwOnRequestTimeout],
        [CLOUD_REQUEST_TIMEOUT_MS, 10_000, true],
        Client.name,
      );
      client.destroy();
    }
    assert.notEqual(awsRequestHandler(), awsRequestHandler(), 'a fresh object per client');
  });

  test('cloudSignal aborts a fetch that takes too long', async () => {
    const srv = http.createServer(() => { /* never answers */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: cloudSignal(100) }), { name: 'TimeoutError' });
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });
});
