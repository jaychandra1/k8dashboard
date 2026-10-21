import { describe, it, expect } from 'vitest';
import { maskAccountId, redactSensitive } from './redact';

describe('redactSensitive — nothing environment-identifying is displayed', () => {
  it('masks AWS account ids, alone, in profile names and in ARNs', () => {
    expect(maskAccountId('241533118296')).toBe('••••8296');
    expect(maskAccountId('not-an-id')).toBe('not-an-id');
    expect(redactSensitive('aws sso login --profile sso-241533118296')).toBe('aws sso login --profile sso-••••8296');
    expect(redactSensitive('arn:aws:eks:eu-west-1:241533118296:cluster/dev')).toBe('arn:aws:eks:eu-west-1:••••8296:cluster/dev');
  });

  it('masks access-portal and cluster endpoint hosts, keeping the region', () => {
    expect(redactSensitive('https://d-906600a9b0.awsapps.com/start')).toBe('https://••••.awsapps.com/start');
    expect(redactSensitive('Get "https://49B8A64035E12DFA22A9C44C3ABF0985.gr7.eu-west-1.eks.amazonaws.com/api"'))
      .toBe('Get "https://••••.eu-west-1.eks.amazonaws.com/api"');
    expect(redactSensitive('https://myaks-dns-1a2b.hcp.westeurope.azmk8s.io:443')).toBe('https://••••.westeurope.azmk8s.io:443');
    expect(redactSensitive('connect https://k8s.corp.internal:6443 failed')).toBe('connect https://••••:6443 failed');
  });

  it('masks IPs, tenant ids and tokens; keeps public docs links and versions', () => {
    expect(redactSensitive('dial tcp 10.24.30.223:443: i/o timeout')).toBe('dial tcp x.x.x.x:443: i/o timeout');
    expect(redactSensitive('tenant 72f988bf-86f1-41af-91ab-2d7cd011db47')).toBe('tenant ••••db47');
    expect(redactSensitive('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl')).toBe('Authorization: Bearer [token]');
    expect(redactSensitive('see https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html'))
      .toBe('see https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html');
    expect(redactSensitive('Kubernetes v1.29.4')).toBe('Kubernetes v1.29.4');
    expect(redactSensitive(null)).toBeNull();
  });
});
