// lib/yaml.mjs: js-yaml 5 set up the way Kubernetes tooling reads YAML.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import yaml, { load, loadAll, dump, YAMLException } from '../lib/yaml.mjs';

describe('YAML for Kubernetes', () => {
  test('merge keys resolve, as with kubectl', () => {
    const doc = load('base: &base\n  replicas: 2\n  image: a\nweb:\n  <<: *base\n  image: b\n');
    assert.deepEqual(doc.web, { replicas: 2, image: 'b' });
  });

  test('scalars stay as written: dates are strings, only true/false are booleans', () => {
    const doc = load('data:\n  when: 2024-01-01\n  at: 2024-01-01T10:00:00Z\n  flag: yes\n  on: off\n  real: true\n  port: 8080\n');
    assert.deepEqual(doc.data, { when: '2024-01-01', at: '2024-01-01T10:00:00Z', flag: 'yes', on: 'off', real: true, port: 8080 });
  });

  test('dump quotes strings a YAML 1.1 reader (Kubernetes) would read as something else', () => {
    const out = dump({ data: { a: 'yes', b: 'on', c: 'off', d: '0755', e: '12:30', f: '2024-01-01', g: 'null', h: '1e3', i: 'plain' } }, { noRefs: true, lineWidth: -1 });
    for (const v of ['yes', 'on', 'off', '0755', '12:30', '2024-01-01', 'null', '1e3']) {
      assert.match(out, new RegExp(`: ['"]${v}['"]\\n`), `${v} must be quoted:\n${out}`);
    }
    assert.match(out, /i: plain\n/);
  });

  test('round trip keeps every value', () => {
    const value = { data: { a: 'yes', d: '0755', f: '2024-01-01', m: 'line one\nline two\n', long: 'x'.repeat(200) }, n: 5, ok: true, none: null };
    assert.deepEqual(load(dump(value, { noRefs: true, lineWidth: -1 })), value);
    assert.deepEqual(load(dump(value)), value);
  });

  test('dumps Kubernetes client objects (class instances) like plain ones', () => {
    class V1ObjectMeta { constructor() { this.name = 'db'; this.creationTimestamp = new Date('2024-01-01T10:00:00Z'); this.labels = { app: 'x' }; } }
    class V1Secret { constructor() { this.apiVersion = 'v1'; this.kind = 'Secret'; this.metadata = new V1ObjectMeta(); this.data = { password: 'aHVudGVyMg==' }; } }
    const out = dump(new V1Secret(), { indent: 2 });
    assert.equal(out, dump({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db', creationTimestamp: new Date('2024-01-01T10:00:00Z'), labels: { app: 'x' } }, data: { password: 'aHVudGVyMg==' } }, { indent: 2 }));
    assert.match(out, /creationTimestamp: 2024-01-01T10:00:00\.000Z\n/, 'a Date is written as a timestamp, as before');
    // One object referenced twice is still one (an anchor unless noRefs).
    const shared = { a: 1 };
    assert.match(dump({ x: shared, y: shared }), /&/);
    assert.doesNotMatch(dump({ x: shared, y: shared }, { noRefs: true }), /&/);
  });

  test('loadAll splits documents; errors are YAMLExceptions', () => {
    assert.deepEqual(loadAll('a: 1\n---\nb: 2\n'), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => load('a: [1, 2'), YAMLException);
    assert.equal(yaml.load, load);
  });
});
