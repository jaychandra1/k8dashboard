import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerOfServer, serverHost } from '../lib/cloud-provider.mjs';

test('cloud provider from the API server host name', () => {
  assert.equal(providerOfServer('https://myaks-dns-1a2b.hcp.westeurope.azmk8s.io:443'), 'azure');
  assert.equal(providerOfServer('https://myaks.privatelink.westeurope.azmk8s.io'), 'azure');
  assert.equal(providerOfServer('https://49B8A64035E12DFA22A9C44C3ABF0985.gr7.eu-west-1.eks.amazonaws.com'), 'aws');
  assert.equal(providerOfServer('https://ABC.yl4.cn-north-1.eks.amazonaws.com.cn'), 'aws');
  assert.equal(providerOfServer('https://gke-0123abcd.us-central1.gke.goog'), 'gcp');
  assert.equal(providerOfServer('https://container.googleapis.com/v1/projects/p/locations/l/clusters/c'), 'gcp');
  assert.equal(providerOfServer('https://127.0.0.1:52341'), 'local');
  assert.equal(providerOfServer('https://kubernetes.docker.internal:6443'), 'local');
  assert.equal(providerOfServer('https://kind-control-plane:6443'), 'local');
  assert.equal(providerOfServer('https://[::1]:8443'), 'local');
  assert.equal(providerOfServer('https://k8s.example.com'), 'other');
  assert.equal(providerOfServer(''), 'other');
  assert.equal(providerOfServer('not a url ::'), 'other');
});

test('a cloud domain outside the host name does not count', () => {
  assert.equal(providerOfServer('https://evil.example.com/.azmk8s.io'), 'other');
  assert.equal(providerOfServer('https://evil.example.com/?h=x.eks.amazonaws.com'), 'other');
  assert.equal(providerOfServer('https://x.eks.amazonaws.com.evil.example@k8s.example.com'), 'other');
  assert.equal(providerOfServer('https://azmk8s.io.evil.example.com'), 'other');
});

test('a bare host gets https://', () => {
  assert.deepEqual(serverHost('abc.hcp.westeurope.azmk8s.io:443'), { host: 'abc.hcp.westeurope.azmk8s.io', port: '' });
  assert.equal(serverHost(''), null);
});
