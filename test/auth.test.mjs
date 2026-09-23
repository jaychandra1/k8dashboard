// Tests for lib/auth.mjs: token sourcing/persistence and the Host / Origin
// allowlists that defend against DNS rebinding and CSRF.
//
// getAuthToken() caches at module level and derives its file path from
// os.homedir() at import time, so every token scenario runs in a fresh child
// process with its own HOME/USERPROFILE.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isAllowedHost,
  isAllowedOrigin,
  parseHost,
  tokenMatches,
  verifyWsAuth,
  isProtectedPath,
} from '../lib/auth.mjs';

const AUTH_URL = pathToFileURL(path.resolve('lib/auth.mjs')).href;
const tmpHomes = [];
after(() => {
  for (const h of tmpHomes) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tokenInChild(env = {}) {
  const home = env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-auth-'));
  if (!env.HOME) tmpHomes.push(home);
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  // Legacy names (K8DASHBOARD_TOKEN, K8SIGHT_TOKEN) are still read by lib/paths.mjs.
  for (const k of ['KUBEPILOT_TOKEN', 'K8DASHBOARD_TOKEN', 'K8SIGHT_TOKEN']) {
    delete childEnv[k];
    if (env[k]) childEnv[k] = env[k];
  }
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { getAuthToken } from ${JSON.stringify(AUTH_URL)}; process.stdout.write(getAuthToken());`,
    ],
    { env: childEnv, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return { token: r.stdout, home, file: path.join(home, '.config', 'kubepilot', 'token') };
}

describe('getAuthToken', () => {
  test('generates a 32-byte base64url token and persists it under ~/.config/kubepilot/token', () => {
    const { token, file } = tokenInChild();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'expected base64url of 32 random bytes');
    assert.ok(fs.existsSync(file), 'token file should be written');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token file must be 0600');
      assert.equal(
        fs.statSync(path.dirname(file)).mode & 0o077,
        0,
        'token dir must not be group/world accessible'
      );
    }
  });

  test('re-uses the persisted token on the next start', () => {
    const first = tokenInChild();
    const second = tokenInChild({ HOME: first.home });
    assert.equal(second.token, first.token);
  });

  test('KUBEPILOT_TOKEN env wins and nothing is written to disk', () => {
    const { token, file } = tokenInChild({ KUBEPILOT_TOKEN: 'env-token-0123456789abcdef' });
    assert.equal(token, 'env-token-0123456789abcdef');
    assert.equal(fs.existsSync(file), false, 'no token file expected when the env var is set');
  });

  test('legacy K8DASHBOARD_TOKEN env is still accepted', () => {
    const { token, file } = tokenInChild({ K8DASHBOARD_TOKEN: 'legacy-token-abcdef1234' });
    assert.equal(token, 'legacy-token-abcdef1234');
    assert.equal(fs.existsSync(file), false);
  });

  test('KUBEPILOT_TOKEN wins over a legacy K8DASHBOARD_TOKEN', () => {
    const { token } = tokenInChild({
      KUBEPILOT_TOKEN: 'new-token-0123456789abcdef',
      K8DASHBOARD_TOKEN: 'legacy-token-abcdef1234',
    });
    assert.equal(token, 'new-token-0123456789abcdef');
  });

  test('legacy K8SIGHT_TOKEN env is still accepted', () => {
    const { token, file } = tokenInChild({ K8SIGHT_TOKEN: 'legacy-token-0123456789ab' });
    assert.equal(token, 'legacy-token-0123456789ab');
    assert.equal(fs.existsSync(file), false);
  });

  test('re-uses a token persisted under the legacy ~/.config/k8dashboard path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-auth-'));
    tmpHomes.push(home);
    const dir = path.join(home, '.config', 'k8dashboard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token'), 'k8dashboard-file-token-0123456789\n');
    const { token } = tokenInChild({ HOME: home });
    assert.equal(token, 'k8dashboard-file-token-0123456789');
  });

  test('re-uses a token persisted under the legacy ~/.config/k8sight path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-auth-'));
    tmpHomes.push(home);
    const dir = path.join(home, '.config', 'k8sight');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token'), 'legacy-file-token-0123456789\n');
    const { token } = tokenInChild({ HOME: home });
    assert.equal(token, 'legacy-file-token-0123456789');
  });

  test('a malformed token file is replaced by a fresh token', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-auth-'));
    tmpHomes.push(home);
    const dir = path.join(home, '.config', 'kubepilot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token'), 'short\n'); // < 16 chars: rejected
    const { token } = tokenInChild({ HOME: home });
    assert.notEqual(token, 'short');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('tokenMatches / verifyWsAuth (in-process, KUBEPILOT_TOKEN=fixed)', () => {
  process.env.KUBEPILOT_TOKEN = 'in-process-token-0123456789';
  test('constant-time compare accepts only the exact token', () => {
    assert.equal(tokenMatches('in-process-token-0123456789'), true);
    assert.equal(tokenMatches('in-process-token-012345678'), false);
    assert.equal(tokenMatches('in-process-token-0123456789x'), false);
    assert.equal(tokenMatches(''), false);
    assert.equal(tokenMatches(null), false);
    assert.equal(tokenMatches(undefined), false);
    assert.equal(tokenMatches(123), false);
  });
  test('WS upgrade accepts ?token= or a Bearer header, nothing else', () => {
    assert.equal(verifyWsAuth({ url: '/ws/exec?token=in-process-token-0123456789', headers: {} }), true);
    assert.equal(
      verifyWsAuth({ url: '/ws/exec', headers: { authorization: 'Bearer in-process-token-0123456789' } }),
      true
    );
    assert.equal(verifyWsAuth({ url: '/ws/exec?token=wrong', headers: {} }), false);
    assert.equal(verifyWsAuth({ url: '/ws/exec', headers: {} }), false);
    assert.equal(verifyWsAuth({ url: '/ws/exec', headers: { authorization: 'Basic abc' } }), false);
  });
  test('protected path prefixes are matched case-insensitively', () => {
    for (const p of ['/api', '/api/x', '/API/x', '/mcp', '/Mcp']) assert.equal(isProtectedPath(p), true, p);
    for (const p of ['/', '/healthz', '/assets/x.js', '/ap', '']) assert.equal(isProtectedPath(p), false, p);
  });
});

describe('parseHost', () => {
  test('splits host[:port] and bracketed IPv6', () => {
    assert.deepEqual(parseHost('localhost:3001'), { hostname: 'localhost', port: '3001' });
    assert.deepEqual(parseHost('127.0.0.1'), { hostname: '127.0.0.1', port: '' });
    assert.deepEqual(parseHost('[::1]:3001'), { hostname: '::1', port: '3001' });
    assert.deepEqual(parseHost('[::1]'), { hostname: '::1', port: '' });
    assert.deepEqual(parseHost('EVIL.Example:80'), { hostname: 'evil.example', port: '80' });
    assert.equal(parseHost(''), null);
    assert.equal(parseHost(undefined), null);
    assert.equal(parseHost('[::1'), null);
  });
});

describe('isAllowedHost', () => {
  const withEnv = (vars, fn) => {
    const saved = {};
    for (const k of ['ALLOWED_HOSTS', 'ALLOWED_ORIGINS']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  test('loopback names are always allowed, any port', () => {
    withEnv({}, () => {
      for (const h of [
        'localhost',
        'localhost:3001',
        'LOCALHOST:3001',
        '127.0.0.1',
        '127.0.0.1:3001',
        '[::1]',
        '[::1]:3001',
        '::1',
      ]) {
        assert.equal(isAllowedHost(h), true, h);
      }
    });
  });

  test('anything else is rejected by default (DNS rebinding)', () => {
    withEnv({}, () => {
      for (const h of [
        'evil.example:3001',
        'evil.example',
        'localhost.evil.example:3001',
        '127.0.0.1.nip.io',
        '10.0.0.5:3001',
        '',
        undefined,
        'kubepilot.internal',
      ]) {
        assert.equal(isAllowedHost(h), false, String(h));
      }
    });
  });

  test('ALLOWED_HOSTS adds exact host:port or bare hostname entries', () => {
    withEnv({ ALLOWED_HOSTS: 'kubepilot.internal, proxy.example:8443' }, () => {
      assert.equal(isAllowedHost('kubepilot.internal'), true);
      assert.equal(isAllowedHost('kubepilot.internal:3001'), true, 'bare hostname entry matches any port');
      assert.equal(isAllowedHost('KUBEPILOT.INTERNAL:3001'), true, 'case-insensitive');
      assert.equal(isAllowedHost('proxy.example:8443'), true);
      assert.equal(isAllowedHost('proxy.example:8444'), false, 'host:port entry is exact');
      assert.equal(isAllowedHost('evil.example:3001'), false);
    });
  });

  test('ALLOWED_ORIGINS hosts are allowed as Host values too', () => {
    withEnv({ ALLOWED_ORIGINS: 'https://ui.example:8443' }, () => {
      assert.equal(isAllowedHost('ui.example:8443'), true);
      assert.equal(isAllowedHost('ui.example'), false);
    });
  });
});

describe('isAllowedOrigin', () => {
  test('missing Origin is allowed (token still required); "null" and foreign origins are not', () => {
    assert.equal(isAllowedOrigin(undefined, 'localhost:3001'), true);
    assert.equal(isAllowedOrigin('', 'localhost:3001'), true);
    assert.equal(isAllowedOrigin('null', 'localhost:3001'), false);
    assert.equal(isAllowedOrigin('http://evil.example', 'localhost:3001'), false);
    assert.equal(isAllowedOrigin('http://localhost:3001', 'evil.example:3001'), false);
  });
  test('same-origin against an allowlisted host passes', () => {
    assert.equal(isAllowedOrigin('http://localhost:3001', 'localhost:3001'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3001', '127.0.0.1:3001'), true);
    assert.equal(
      isAllowedOrigin('http://localhost:3001', '127.0.0.1:3001'),
      false,
      'host must match exactly'
    );
  });
});
