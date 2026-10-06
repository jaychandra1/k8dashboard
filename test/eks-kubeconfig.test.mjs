// lib/eks-kubeconfig.mjs: how discovered EKS clusters relate to the kubeconfig
// (drives the AWS dialog after a fresh sign-in and guards the import).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execArg, eksEntryFor, sameEksCluster, eksClusterStatus } from '../lib/eks-kubeconfig.mjs';

const kc = {
  contexts: [
    { name: 'dev-env-cluster', user: 'u-dev' },
    { name: 'pixdora-tech', user: 'u-pix' },
    { name: 'legacy', user: 'u-legacy' },
    { name: 'prod', user: 'u-cli' },
    { name: 'shared-name', user: 'u-cert' },
  ],
  users: [
    { name: 'u-dev', exec: { command: 'KubePilot.exe', args: ['--token-helper', 'eks', '--cluster', 'dev-env-cluster', '--region', 'eu-west-1', '--profile', 'sso-111122223333'] } },
    { name: 'u-pix', exec: { command: 'KubePilot.exe', args: ['--token-helper', 'eks', '--cluster=pixdora-tech', '--region=eu-west-1', '--profile=sso-111122223333'] } },
    { name: 'u-legacy', exec: { command: 'KubePilot.exe', args: ['--token-helper', 'eks', '--cluster', 'legacy', '--region', 'eu-west-1', '--profile', 'old-static'] } },
    { name: 'u-cli', exec: { command: 'aws', args: ['--region', 'us-east-1', 'eks', 'get-token', '--cluster-name', 'prod'], env: [{ name: 'AWS_PROFILE', value: 'team' }] } },
    { name: 'u-cert', certData: 'x', keyData: 'y' },
  ],
};
const profiles = [
  { name: 'sso-111122223333', type: 'sso', ssoStartUrl: 'https://my-org.awsapps.com/start', ssoAccountId: '111122223333', ssoRoleName: 'Admin' },
  { name: 'old-static', type: 'access-key' },
];
const sso = { startUrl: 'https://my-org.awsapps.com/start', account: '111122223333', role: 'Admin' };

describe('reading kubeconfig entries', () => {
  test('execArg handles "--flag value" and "--flag=value"', () => {
    assert.equal(execArg(['--cluster', 'a'], '--cluster'), 'a');
    assert.equal(execArg(['--cluster=b'], '--cluster'), 'b');
    assert.equal(execArg(['--cluster-name', 'c'], '--cluster', '--cluster-name'), 'c');
    assert.equal(execArg(['--cluster'], '--cluster'), undefined);
  });

  test('our token helper and `aws eks get-token` entries both resolve to cluster / region / profile', () => {
    assert.deepEqual(eksEntryFor(kc, 'dev-env-cluster'), { cluster: 'dev-env-cluster', region: 'eu-west-1', profile: 'sso-111122223333' });
    assert.deepEqual(eksEntryFor(kc, 'prod'), { cluster: 'prod', region: 'us-east-1', profile: 'team' });
    assert.deepEqual(eksEntryFor(kc, 'shared-name'), { cluster: undefined, region: undefined, profile: undefined });
    assert.equal(eksEntryFor(kc, 'missing'), null);
  });

  test('sameEksCluster needs the same name, and the same region when one is recorded', () => {
    assert.equal(sameEksCluster({ cluster: 'a', region: 'eu-west-1' }, { name: 'a', region: 'eu-west-1' }), true);
    assert.equal(sameEksCluster({ cluster: 'a' }, { name: 'a', region: 'eu-west-1' }), true);
    assert.equal(sameEksCluster({ cluster: 'a', region: 'us-east-1' }, { name: 'a', region: 'eu-west-1' }), false);
    assert.equal(sameEksCluster({ cluster: undefined }, { name: 'a', region: 'eu-west-1' }), false);
    assert.equal(sameEksCluster(null, { name: 'a', region: 'eu-west-1' }), false);
  });
});

describe('cluster status after an AWS SSO sign-in', () => {
  const found = [
    { name: 'dev-env-cluster', region: 'eu-west-1', account: '111122223333' },
    { name: 'pixdora-tech', region: 'eu-west-1', account: '111122223333' },
    { name: 'legacy', region: 'eu-west-1', account: '111122223333' },
    { name: 'shared-name', region: 'eu-west-1', account: '111122223333' },
    { name: 'brand-new', region: 'eu-west-1', account: '111122223333' },
  ];
  const byName = Object.fromEntries(eksClusterStatus(kc, found, { sso }, profiles).map((c) => [c.name, c]));

  test('clusters whose entry uses this SSO start URL, account and role need nothing: current', () => {
    assert.deepEqual(byName['dev-env-cluster'], { name: 'dev-env-cluster', region: 'eu-west-1', account: '111122223333', imported: true, current: true });
    assert.equal(byName['pixdora-tech'].current, true);
  });

  test('an entry for the same cluster with other credentials can be updated', () => {
    assert.deepEqual(byName.legacy, { name: 'legacy', region: 'eu-west-1', account: '111122223333', imported: true, current: false });
  });

  test('a different cluster or config holding the same name is a conflict (never overwritten)', () => {
    assert.equal(byName['shared-name'].conflict, true);
    assert.equal(byName['shared-name'].current, undefined);
  });

  test('a cluster not in the kubeconfig yet is simply new', () => {
    assert.deepEqual(byName['brand-new'], { name: 'brand-new', region: 'eu-west-1', account: '111122223333', imported: false });
  });

  test('another role in the same account is not "current"', () => {
    const [c] = eksClusterStatus(kc, [found[0]], { sso: { ...sso, role: 'ReadOnly' } }, profiles);
    assert.equal(c.current, false);
  });

  test('a cluster added in another region with the same name is a conflict', () => {
    const [c] = eksClusterStatus(kc, [{ name: 'dev-env-cluster', region: 'us-west-2' }], { sso }, profiles);
    assert.equal(c.conflict, true);
  });
});

describe('cluster status after discovering with a saved profile', () => {
  test('current when the entry uses that profile; otherwise updatable', () => {
    const [same, other] = eksClusterStatus(kc, [{ name: 'prod', region: 'us-east-1' }, { name: 'legacy', region: 'eu-west-1' }], { profile: 'team' });
    assert.equal(same.current, true);
    assert.equal(other.current, false);
  });
});
