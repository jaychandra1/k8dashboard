// Assistant redaction: Secret data and env values must never reach the LLM.
//
// TODO(assistant.js owner): `redactSecret` and `maskEnvValues` are module-local
// consts in assistant.js. Export them (e.g. `export { redactSecret, maskEnvValues }`)
// and these tests activate automatically; until then they are skipped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../assistant.js');
const redactSecret = mod.redactSecret;
const maskEnv = mod.maskEnvValues || mod.maskEnv;
const skipRedact =
  typeof redactSecret !== 'function' ? 'assistant.js does not export redactSecret (TODO)' : false;
const skipMask =
  typeof maskEnv !== 'function' ? 'assistant.js does not export maskEnvValues/maskEnv (TODO)' : false;

describe('redactSecret', { skip: skipRedact }, () => {
  test('replaces every Secret data/stringData value', () => {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'db', namespace: 'default' },
      data: {
        password: Buffer.from('hunter2').toString('base64'),
        user: Buffer.from('root').toString('base64'),
      },
      stringData: { token: 'plain-token' },
    };
    const out = JSON.stringify(redactSecret(structuredClone(secret), 'Secret'));
    assert.doesNotMatch(out, /hunter2|aHVudGVyMg==|plain-token|cm9vdA==/);
    assert.match(out, /"password"/, 'keys are kept so the model can reason about shape');
  });

  test('leaves non-secret objects intact apart from env masking', () => {
    const cm = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x' }, data: { LOG_LEVEL: 'debug' } };
    const out = redactSecret(structuredClone(cm), 'ConfigMap');
    assert.equal(out.data.LOG_LEVEL, 'debug');
  });

  test('handles null / undefined safely', () => {
    assert.doesNotThrow(() => redactSecret(null, 'Secret'));
    assert.doesNotThrow(() => redactSecret(undefined, 'Pod'));
  });
});

describe('maskEnvValues', { skip: skipMask }, () => {
  test('masks literal env values in every container type', () => {
    const podSpec = {
      containers: [
        {
          name: 'app',
          env: [
            { name: 'DB_PASSWORD', value: 's3cret' },
            { name: 'MODE', value: 'prod' },
          ],
        },
      ],
      initContainers: [{ name: 'init', env: [{ name: 'API_KEY', value: 'abc123' }] }],
    };
    maskEnv(podSpec);
    const out = JSON.stringify(podSpec);
    assert.doesNotMatch(out, /s3cret|abc123/);
    assert.match(out, /"DB_PASSWORD"/);
  });

  test('keeps valueFrom references (they contain no secret material)', () => {
    const podSpec = {
      containers: [{ name: 'a', env: [{ name: 'X', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }] }],
    };
    maskEnv(podSpec);
    assert.equal(podSpec.containers[0].env[0].valueFrom.secretKeyRef.name, 's');
  });
});
