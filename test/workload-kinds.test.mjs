// Replica Sets, Replication Controllers, Jobs and Cron Jobs: listed by
// /api/resources/:ns (the views read them by the UI's plural keys), with the
// columns the tables show, and readable in the details drawer and the YAML
// editor (REST-mapping fallback) — against a fake API server, and in demo mode.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { formatResource } from '../lib/resource-format.mjs';

const RS = {
  apiVersion: 'apps/v1', kind: 'ReplicaSet',
  metadata: { name: 'web-7f9c6d5b4', namespace: 'shop', creationTimestamp: '2026-10-01T00:00:00Z', ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] },
  spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 2 },
};
const OLD_RS = { ...RS, metadata: { ...RS.metadata, name: 'web-5c4d3b2a1' }, spec: { replicas: 0 }, status: { replicas: 0 } };
const RC = { apiVersion: 'v1', kind: 'ReplicationController', metadata: { name: 'legacy', namespace: 'shop', creationTimestamp: '2026-09-01T00:00:00Z' }, spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 1 } };
const JOB_DONE = {
  apiVersion: 'batch/v1', kind: 'Job',
  metadata: { name: 'backup-29000000', namespace: 'shop', creationTimestamp: '2026-11-03T02:00:00Z', ownerReferences: [{ kind: 'CronJob', name: 'backup', controller: true }] },
  spec: { completions: 1 },
  status: { succeeded: 1, startTime: '2026-11-03T02:00:00Z', completionTime: '2026-11-03T02:03:20Z', conditions: [{ type: 'Complete', status: 'True' }] },
};
const JOB_FAILED = {
  apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'migrate', namespace: 'shop', creationTimestamp: '2026-11-03T01:00:00Z' },
  spec: { completions: 1 },
  status: { failed: 3, startTime: '2026-11-03T01:00:00Z', conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T01:00:45Z' }] },
};
const CRON = {
  apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'backup', namespace: 'shop', creationTimestamp: '2026-08-01T00:00:00Z' },
  spec: { schedule: '0 2 * * *', timeZone: 'Europe/Malta' }, status: { lastScheduleTime: '2026-11-03T02:00:00Z', lastSuccessfulTime: '2026-11-03T02:03:20Z' },
};
const list = (items) => ({ metadata: {}, items });

function fakeKubeApi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const routes = {
      '/apis/apps/v1/namespaces/shop/replicasets': list([RS, OLD_RS]),
      '/api/v1/namespaces/shop/replicationcontrollers': list([RC]),
      '/apis/batch/v1/namespaces/shop/jobs': list([JOB_DONE, JOB_FAILED]),
      '/apis/batch/v1/namespaces/shop/cronjobs': list([CRON]),
      '/apis/apps/v1/namespaces/shop/replicasets/web-7f9c6d5b4': RS,
      '/apis/batch/v1/namespaces/shop/cronjobs/backup': CRON,
    };
    if (routes[url.pathname]) return json(routes[url.pathname]);
    // Every other namespaced list the fan-out asks for is empty.
    if (/^\/(api|apis)\/.*\/namespaces\/shop\/[a-z]+$/.test(url.pathname)) return json(list([]));
    return json({ kind: 'Status', code: 404, message: 'not found' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('row shape for the workload kinds (lib/resource-format.mjs)', () => {
  test('ReplicaSet / ReplicationController: ready/desired status, desired/current/ready, owner', () => {
    assert.deepEqual(
      (({ status, desired, current, ready, owner }) => ({ status, desired, current, ready, owner }))(formatResource(RS, 'ReplicaSet')),
      { status: '2/3', desired: 3, current: 3, ready: 2, owner: 'Deployment web' },
    );
    assert.equal(formatResource(OLD_RS, 'ReplicaSet').status, '0/0');
    assert.equal(formatResource(RC, 'ReplicationController').owner, '');
  });

  test('Job: Complete / Failed / Running / Suspended / Pending, completions, duration, owner', () => {
    const done = formatResource(JOB_DONE, 'Job');
    assert.deepEqual([done.status, done.completions, done.durationSeconds, done.owner], ['Complete', '1/1', 200, 'CronJob backup']);
    const failed = formatResource(JOB_FAILED, 'Job');
    assert.deepEqual([failed.status, failed.completions, failed.durationSeconds], ['Failed', '0/1', 45]);
    assert.equal(formatResource({ metadata: { name: 'j' }, spec: {}, status: { active: 1 } }, 'Job').status, 'Running');
    assert.equal(formatResource({ metadata: { name: 'j' }, spec: { suspend: true }, status: {} }, 'Job').status, 'Suspended');
    assert.equal(formatResource({ metadata: { name: 'j' }, spec: {}, status: {} }, 'Job').status, 'Pending');
  });

  test('Pod: STATUS like kubectl — container reasons over the phase, init progress, Terminating', () => {
    const pod = (status, extra = {}) => formatResource({ metadata: { name: 'p', ...extra.metadata }, spec: { containers: [{ name: 'app' }], ...extra.spec }, status }, 'Pod');
    const running = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] };
    assert.deepEqual([pod(running).status, pod(running).phase], ['Running', 'Running']);
    // The phase says Running; the container is crash-looping.
    const crash = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] });
    assert.deepEqual([crash.status, crash.phase], ['CrashLoopBackOff', 'Running']);
    assert.equal(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ImagePullBackOff' } } }] }).status, 'ImagePullBackOff');
    assert.equal(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] }).status, 'ContainerCreating');
    assert.equal(pod({ phase: 'Running', containerStatuses: [{ name: 'app', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }).status, 'OOMKilled');
    assert.equal(pod({ phase: 'Failed', containerStatuses: [{ name: 'app', state: { terminated: { exitCode: 2 } } }] }).status, 'ExitCode:2');
    assert.equal(pod({ phase: 'Succeeded', containerStatuses: [{ name: 'app', state: { terminated: { reason: 'Completed', exitCode: 0 } } }] }).status, 'Completed');
    assert.equal(pod({ phase: 'Failed', reason: 'Evicted' }).status, 'Evicted');
    // Init containers: progress, then their failure.
    const initSpec = { spec: { containers: [{ name: 'app' }], initContainers: [{ name: 'migrate' }, { name: 'seed' }] } };
    assert.equal(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'migrate', state: { terminated: { exitCode: 0 } } }, { name: 'seed', state: { running: {} } }] }, initSpec).status, 'Init:1/2');
    assert.equal(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'migrate', state: { waiting: { reason: 'CrashLoopBackOff' } } }] }, initSpec).status, 'Init:CrashLoopBackOff');
    assert.equal(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'migrate', state: { terminated: { reason: 'Error', exitCode: 1 } } }] }, initSpec).status, 'Init:Error');
    // A native sidecar (restartPolicy: Always) keeps running and doesn't hold the pod in Init.
    const sidecar = { spec: { containers: [{ name: 'app' }], initContainers: [{ name: 'proxy', restartPolicy: 'Always' }] } };
    assert.equal(pod({ ...running, initContainerStatuses: [{ name: 'proxy', state: { running: {} } }] }, sidecar).status, 'Running');
    assert.equal(pod(running, { metadata: { deletionTimestamp: '2026-11-04T10:00:00Z' } }).status, 'Terminating');
  });

  test('Service: type and ports like kubectl PORT(S), no addresses', () => {
    const svc = formatResource({ metadata: { name: 's' }, spec: { type: 'NodePort', clusterIP: '10.0.0.7', ports: [{ port: 80, protocol: 'TCP' }, { port: 443, nodePort: 30443 }] } }, 'Service');
    assert.deepEqual([svc.serviceType, svc.ports, svc.status], ['NodePort', '80/TCP, 443:30443/TCP', 'NodePort']);
    assert.ok(!JSON.stringify(svc).includes('10.0.0.7'), 'the cluster IP is not in the row');
  });

  test('CronJob: Scheduled / Active / Suspended, schedule, last run, active jobs', () => {
    const c = formatResource(CRON, 'CronJob');
    assert.deepEqual([c.status, c.schedule, c.timeZone, c.lastSchedule, c.activeJobs, c.suspend], ['Scheduled', '0 2 * * *', 'Europe/Malta', '2026-11-03T02:00:00Z', 0, false]);
    assert.equal(formatResource({ ...CRON, status: { active: [{ name: 'backup-1' }] } }, 'CronJob').status, 'Active');
    assert.equal(formatResource({ ...CRON, spec: { ...CRON.spec, suspend: true } }, 'CronJob').status, 'Suspended');
  });
});

describe('real cluster: /api/resources lists them; details + YAML read them', () => {
  let srv, kube, dir;
  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-workloads-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'http://127.0.0.1:${kube.address().port}', insecure-skip-tls-verify: true }
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
    kube?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every namespaced view has its list — replicaSets, replicationControllers, jobs, cronJobs included', async () => {
    const r = await (await srv.authed('/api/resources/shop')).json();
    assert.equal(r.partial, undefined, JSON.stringify(r.errors));
    assert.deepEqual(r.replicaSets.map((x) => [x.name, x.status, x.owner]), [['web-7f9c6d5b4', '2/3', 'Deployment web'], ['web-5c4d3b2a1', '0/0', 'Deployment web']]);
    assert.deepEqual(r.replicationControllers.map((x) => [x.name, x.status]), [['legacy', '1/1']]);
    assert.deepEqual(r.jobs.map((x) => [x.name, x.status]), [['backup-29000000', 'Complete'], ['migrate', 'Failed']]);
    assert.deepEqual(r.cronJobs.map((x) => [x.name, x.status, x.schedule]), [['backup', 'Scheduled', '0 2 * * *']]);
  });

  test('the details drawer and the YAML editor read them through the REST mapping', async () => {
    const rs = await (await srv.authed('/api/resource/shop/ReplicaSet/web-7f9c6d5b4')).json();
    assert.equal(rs.metadata.name, 'web-7f9c6d5b4');
    const y = await srv.authed('/api/yaml/shop/cronJob/backup');
    assert.equal(y.status, 200);
    assert.match((await y.json()).yaml, /schedule: 0 2 \* \* \*/);
    const missing = await srv.authed('/api/resource/shop/Job/nope');
    assert.equal(missing.status, 404);
  });
});

describe('demo mode: the same lists', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { KUBEPILOT_DEMO: '1' } }); });
  after(async () => { await srv?.stop(); });

  test('each demo Deployment owns a ReplicaSet named like its pods’ owner; jobs and cron jobs are listed', async () => {
    await srv.authed('/api/config/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextName: 'demo-cluster' }) });
    const r = await (await srv.authed('/api/resources/shop')).json();
    const deployments = r.deployments.map((d) => d.name).sort();
    assert.deepEqual(r.replicaSets.map((x) => x.owner.replace('Deployment ', '')).sort(), deployments);
    assert.ok(r.replicaSets.some((x) => x.name === 'frontend-7f9c6d5b4'), JSON.stringify(r.replicaSets.map((x) => x.name)));
    assert.ok(r.jobs.length > 0 && r.cronJobs.length > 0);
    assert.deepEqual(r.replicationControllers, []);
  });
});
