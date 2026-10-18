// AWS IAM Identity Center sign-in (lib/aws-sso.mjs): PKCE + the loopback
// callback, the device fallback, the [sso-session] config edits, the
// refreshable token cache — and that the AWS SDK itself accepts and renews
// what we write. AWS is never contacted: OIDC is a fake.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeStartUrl,
  sessionNameFor,
  pkcePair,
  buildAuthorizeUrl,
  startCallbackServer,
  createSsoLogin,
  parseAwsConfig,
  ensureSsoSession,
  convertLegacyProfiles,
  upsertSsoProfile,
  profileSsoInfo,
  sessionsForProfiles,
  saveAwsConfig,
  adoptSsoLogin,
  refreshSsoToken,
  sessionTokenState,
  tokenCacheDoc,
  REGISTERED_REDIRECT_URI,
} from '../lib/aws-sso.mjs';

const START = 'https://d-906600a9b0.awsapps.com/start';
const b64url = (b) => Buffer.from(b).toString('base64url');
const get = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
const awsErr = (name, message = name) => Object.assign(new Error(message), { name });

// A temporary HOME / AWS config for everything that touches ~/.aws.
let home;
const saved = {};
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-aws-sso-'));
  for (const k of ['HOME', 'USERPROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'])
    saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AWS_CONFIG_FILE = path.join(home, '.aws', 'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(home, '.aws', 'credentials');
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
const cacheFile = (id) =>
  path.join(home, '.aws', 'sso', 'cache', `${crypto.createHash('sha1').update(id).digest('hex')}.json`);
const readCache = (id) => JSON.parse(fs.readFileSync(cacheFile(id), 'utf8'));

describe('PKCE, authorize URL and the loopback callback', () => {
  test('start URL normalisation and session names', () => {
    assert.equal(normalizeStartUrl(' https://d-1.awsapps.com/start/#/ '), 'https://d-1.awsapps.com/start');
    assert.equal(sessionNameFor(START), 'kubepilot-d-906600a9b0');
    assert.match(sessionNameFor('not a url'), /^kubepilot-[0-9a-f]{10}$/);
  });

  test('PKCE: S256 challenge of a 43-char URL-safe verifier', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, b64url(crypto.createHash('sha256').update(verifier).digest()));
  });

  test("authorize URL: regional endpoint, AWS's `scopes` parameter, PKCE fields", () => {
    const u = new URL(
      buildAuthorizeUrl({
        region: 'us-east-1',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:5555/oauth/callback',
        state: 'st',
        challenge: 'ch',
      })
    );
    assert.equal(u.origin + u.pathname, 'https://oidc.us-east-1.amazonaws.com/authorize');
    assert.deepEqual(Object.fromEntries(u.searchParams), {
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:5555/oauth/callback',
      state: 'st',
      code_challenge_method: 'S256',
      scopes: 'sso:account:access',
      code_challenge: 'ch',
    });
  });

  test('callback: wrong state is refused and ignored; the right one delivers the code, then the port closes', async () => {
    const cb = await startCallbackServer({ state: 'good-state', timeoutMs: 10_000 });
    assert.match(cb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    const bad = await get(`${cb.redirectUri}?code=x&state=evil`);
    assert.equal(bad.status, 400);
    assert.equal((await get(cb.redirectUri.replace('/oauth/callback', '/other'))).status, 404);
    const ok = await get(`${cb.redirectUri}?code=the-code&state=good-state`);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /signed in to AWS/);
    assert.deepEqual(await cb.result, { code: 'the-code' });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      get(`${cb.redirectUri}?code=again&state=good-state`),
      /ECONNREFUSED|socket hang up|ECONNRESET/
    );
  });

  test('callback: AWS error, timeout and cancel', async () => {
    const denied = await startCallbackServer({ state: 's1' });
    const page = await get(
      `${denied.redirectUri}?error=access_denied&error_description=User%20denied&state=s1`
    );
    assert.match(page.body, /didn’t finish/);
    await assert.rejects(denied.result, (e) => e.code === 'denied');
    const slow = await startCallbackServer({ state: 's2', timeoutMs: 50 });
    await assert.rejects(slow.result, (e) => e.code === 'timeout');
    const cancelled = await startCallbackServer({ state: 's3' });
    cancelled.close();
    await assert.rejects(cancelled.result, (e) => e.code === 'cancelled');
  });
});

// Fake SSO OIDC: records calls, answers per command.
function fakeOidc(handlers) {
  const calls = [];
  const oidc = (region) => ({
    send: async (cmd) => {
      const name = cmd.constructor.name;
      calls.push({ region, name, input: cmd.input });
      const h = handlers[name];
      if (!h) throw new Error(`unexpected ${name}`);
      return h(cmd.input, region);
    },
  });
  oidc.calls = calls;
  return oidc;
}
const REG = {
  clientId: 'cid-1',
  clientSecret: 'secret-1',
  clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 90 * 86400,
};
const TOKENS = { accessToken: 'access-1', expiresIn: 3600, refreshToken: 'refresh-1' };

describe('sign-in manager', () => {
  test('browser (PKCE): registers for authorization_code + refresh, exchanges the code with the verifier', async () => {
    const oidc = fakeOidc({
      RegisterClientCommand: () => REG,
      CreateTokenCommand: () => TOKENS,
    });
    const login = createSsoLogin({ oidc, browserAvailable: true });
    const snap = await login.start({ startUrl: `${START}/`, ssoRegion: 'us-east-1' });
    assert.equal(snap.status, 'pending');
    assert.equal(snap.method, 'browser');
    const reg = oidc.calls.find((c) => c.name === 'RegisterClientCommand').input;
    assert.deepEqual(reg, {
      clientName: 'kubepilot',
      clientType: 'public',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [REGISTERED_REDIRECT_URI],
      issuerUrl: START,
      scopes: ['sso:account:access'],
    });
    const auth = new URL(snap.authUrl);
    const redirect = auth.searchParams.get('redirect_uri');
    await get(`${redirect}?code=auth-code&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
    for (let i = 0; i < 50 && login.snapshot().status === 'pending'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await login.poll()).status, 'done');
    const tok = oidc.calls.find((c) => c.name === 'CreateTokenCommand').input;
    assert.equal(tok.grantType, 'authorization_code');
    assert.equal(tok.code, 'auth-code');
    assert.equal(tok.redirectUri, redirect);
    assert.equal(
      b64url(crypto.createHash('sha256').update(tok.codeVerifier).digest()),
      auth.searchParams.get('code_challenge')
    );
    const result = login.takeResult();
    assert.equal(result.refreshToken, 'refresh-1');
    assert.equal(result.startUrl, START);
    assert.equal(login.takeResult(), null, 'handed out once');
  });

  test('browser: AWS denial and cancel are reported, never "done"', async () => {
    const oidc = fakeOidc({ RegisterClientCommand: () => REG, CreateTokenCommand: () => TOKENS });
    const login = createSsoLogin({ oidc, browserAvailable: true });
    const snap = await login.start({ startUrl: START, ssoRegion: 'us-east-1' });
    const auth = new URL(snap.authUrl);
    await get(
      `${auth.searchParams.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(auth.searchParams.get('state'))}`
    );
    for (let i = 0; i < 50 && login.snapshot().status === 'pending'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(login.snapshot().status, 'error');
    assert.equal(login.snapshot().errorCode, 'denied');
    const second = await login.start({ startUrl: START, ssoRegion: 'us-east-1' });
    login.cancel();
    assert.equal(login.snapshot().status, 'cancelled');
    await assert.rejects(
      get(new URL(second.authUrl).searchParams.get('redirect_uri')),
      /ECONNREFUSED|ECONNRESET|socket hang up/
    );
  });

  test('device code: scoped registration, pending → done; detects the region from the start URL', async () => {
    let polls = 0;
    const oidc = fakeOidc({
      RegisterClientCommand: () => REG,
      StartDeviceAuthorizationCommand: (input, region) => {
        if (region !== 'eu-west-1') throw awsErr('InvalidRequestException', 'Invalid start url');
        return {
          deviceCode: 'dev-code',
          userCode: 'ABCD-EFGH',
          verificationUriComplete: 'https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH',
          interval: 1,
          expiresIn: 600,
        };
      },
      CreateTokenCommand: () => {
        polls += 1;
        if (polls < 2) throw awsErr('AuthorizationPendingException');
        return TOKENS;
      },
    });
    let t = 1_000_000;
    const login = createSsoLogin({ oidc, browserAvailable: true, now: () => t });
    const snap = await login.start({ startUrl: START, method: 'device' });
    assert.equal(snap.method, 'device');
    assert.equal(snap.ssoRegion, 'eu-west-1');
    assert.equal(snap.userCode, 'ABCD-EFGH');
    assert.deepEqual(oidc.calls.find((c) => c.name === 'RegisterClientCommand').input.scopes, [
      'sso:account:access',
    ]);
    assert.equal((await login.poll()).status, 'pending');
    assert.equal((await login.poll()).status, 'pending', 'waits for the interval');
    t += 1500;
    assert.equal((await login.poll()).status, 'done');
    assert.equal(
      oidc.calls.filter((c) => c.name === 'CreateTokenCommand').at(-1).input.grantType,
      'urn:ietf:params:oauth:grant-type:device_code'
    );
  });

  test('no browser outside the desktop app; expired codes and bad URLs', async () => {
    const oidc = fakeOidc({
      RegisterClientCommand: () => REG,
      StartDeviceAuthorizationCommand: () => ({
        deviceCode: 'd',
        userCode: 'U',
        verificationUri: 'https://device',
        interval: 1,
        expiresIn: 1,
      }),
    });
    let t = 0;
    const login = createSsoLogin({ oidc, browserAvailable: false, now: () => t });
    assert.equal((await login.start({ startUrl: START, ssoRegion: 'us-east-1' })).method, 'device');
    t = 5000;
    const s = await login.poll();
    assert.equal(s.status, 'error');
    assert.equal(s.errorCode, 'expired');
    await assert.rejects(login.start({ startUrl: 'http://not-https' }), /access portal/);
  });
});

describe('~/.aws/config edits', () => {
  const LEGACY = `# my AWS config
[default]
region = eu-west-1

[profile sso-241533118296]
sso_start_url = ${START}/
sso_region = us-east-1
sso_account_id = 241533118296
sso_role_name = AdministratorAccess
region = eu-west-1
s3 =
  max_concurrent_requests = 20

[profile other-portal]
sso_start_url = https://d-other.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111111111111
sso_role_name = ReadOnly
`;

  test('a new session is added; an existing one for the URL (aws configure sso) is reused', () => {
    const a = ensureSsoSession(LEGACY, { startUrl: START, ssoRegion: 'us-east-1' });
    assert.equal(a.created, true);
    assert.equal(a.name, 'kubepilot-d-906600a9b0');
    assert.match(
      a.text,
      /\[sso-session kubepilot-d-906600a9b0\]\nsso_start_url = https:\/\/d-906600a9b0\.awsapps\.com\/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access/
    );
    const mine = `[sso-session corp]\nsso_start_url = ${START}\nsso_region = us-east-1\n`;
    assert.deepEqual(ensureSsoSession(mine, { startUrl: START, ssoRegion: 'us-east-1' }), {
      text: mine,
      name: 'corp',
      created: false,
    });
    const clash = `[sso-session kubepilot-d-906600a9b0]\nsso_start_url = https://elsewhere.awsapps.com/start\nsso_region = us-east-1\n`;
    assert.equal(
      ensureSsoSession(clash, { startUrl: START, ssoRegion: 'us-east-1' }).name,
      'kubepilot-d-906600a9b0-2'
    );
  });

  test('legacy profiles of the URL point at the session; everything else is untouched; converting twice is a no-op', () => {
    const { text, name } = ensureSsoSession(LEGACY, { startUrl: START, ssoRegion: 'us-east-1' });
    const conv = convertLegacyProfiles(text, { startUrl: START, ssoRegion: 'us-east-1', sessionName: name });
    assert.deepEqual(conv.converted, ['sso-241533118296']);
    const cfg = parseAwsConfig(conv.text);
    assert.deepEqual(cfg.sections.get('profile:sso-241533118296').values, {
      sso_session: name,
      sso_account_id: '241533118296',
      sso_role_name: 'AdministratorAccess',
      region: 'eu-west-1',
      s3: '',
    });
    assert.match(conv.text, /^# my AWS config/);
    assert.match(conv.text, /s3 =\n {2}max_concurrent_requests = 20/);
    assert.equal(
      cfg.sections.get('profile:other-portal').values.sso_start_url,
      'https://d-other.awsapps.com/start'
    );
    assert.deepEqual(
      convertLegacyProfiles(conv.text, { startUrl: START, ssoRegion: 'us-east-1', sessionName: name })
        .converted,
      []
    );
    assert.deepEqual(profileSsoInfo(conv.text, 'sso-241533118296'), {
      profile: 'sso-241533118296',
      sessionName: name,
      startUrl: START,
      ssoRegion: 'us-east-1',
      accountId: '241533118296',
      roleName: 'AdministratorAccess',
    });
    assert.equal(profileSsoInfo(LEGACY, 'other-portal').sessionName, null);
    assert.equal(profileSsoInfo(LEGACY, 'default'), null);
    assert.deepEqual(sessionsForProfiles(conv.text, ['sso-241533118296', 'other-portal', 'nope']), [name]);
  });

  test('upsert: adds a profile, or replaces only its SSO keys', () => {
    const added = upsertSsoProfile('', {
      name: 'sso-1',
      sessionName: 's',
      accountId: '111111111111',
      roleName: 'Admin',
      region: 'eu-west-1',
    });
    assert.equal(
      added,
      '[profile sso-1]\nsso_session = s\nsso_account_id = 111111111111\nsso_role_name = Admin\nregion = eu-west-1\n'
    );
    const replaced = upsertSsoProfile('[profile sso-1]\nsso_start_url = x\noutput = json\n', {
      name: 'sso-1',
      sessionName: 's',
      accountId: '111111111111',
      roleName: 'Admin',
    });
    assert.deepEqual(parseAwsConfig(replaced).sections.get('profile:sso-1').values, {
      sso_session: 's',
      sso_account_id: '111111111111',
      sso_role_name: 'Admin',
      output: 'json',
    });
  });

  test('the original config is backed up once, the first time it is changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-awscfg-'));
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, 'original\n');
    assert.equal(saveAwsConfig(file, 'v2\n'), true);
    assert.equal(saveAwsConfig(file, 'v2\n'), false, 'no change, no write');
    saveAwsConfig(file, 'v3\n');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.kubepilot-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'original\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('storing a sign-in, renewing it, and the AWS SDK reading it', () => {
  beforeEach(() => {
    fs.rmSync(path.join(home, '.aws'), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.writeFileSync(
      process.env.AWS_CONFIG_FILE,
      `[profile sso-241533118296]\nsso_start_url = ${START}\nsso_region = us-east-1\nsso_account_id = 241533118296\nsso_role_name = Admin\n`
    );
  });
  const result = { startUrl: START, ssoRegion: 'us-east-1', ...TOKENS, ...REG };

  test('adopt: session block, converted profile, refreshable cache (session + start-URL copy)', () => {
    const out = adoptSsoLogin(result);
    assert.deepEqual(out, {
      sessionName: 'kubepilot-d-906600a9b0',
      converted: ['sso-241533118296'],
      created: true,
    });
    const cfg = parseAwsConfig(fs.readFileSync(process.env.AWS_CONFIG_FILE, 'utf8'));
    assert.equal(cfg.sections.get('profile:sso-241533118296').values.sso_session, 'kubepilot-d-906600a9b0');
    const tok = readCache('kubepilot-d-906600a9b0');
    assert.deepEqual(Object.keys(tok).sort(), [
      'accessToken',
      'clientId',
      'clientSecret',
      'expiresAt',
      'refreshToken',
      'region',
      'registrationExpiresAt',
      'startUrl',
    ]);
    assert.equal(tok.refreshToken, 'refresh-1');
    assert.match(tok.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(readCache(START).accessToken, 'access-1');
    assert.equal(
      fs.readdirSync(path.join(home, '.aws')).filter((f) => f.startsWith('config.kubepilot-backup-')).length,
      1
    );
    assert.equal(sessionTokenState('kubepilot-d-906600a9b0').refreshable, true);
  });

  test('renewal: only near expiry, rotates the refresh token, reports a finished session as expired', async () => {
    adoptSsoLogin(result);
    // AWS rotates refresh tokens: only the latest one is accepted.
    let valid = 'refresh-1';
    const oidc = fakeOidc({
      CreateTokenCommand: (input) => {
        if (input.refreshToken !== valid) throw awsErr('InvalidGrantException');
        valid = 'refresh-2';
        return { accessToken: 'access-2', expiresIn: 3600, refreshToken: 'refresh-2' };
      },
    });
    assert.equal((await refreshSsoToken('kubepilot-d-906600a9b0', { oidc })).status, 'fresh');
    assert.equal(oidc.calls.length, 0);
    const later = Date.now() + 50 * 60 * 1000; // 10 minutes left
    const r = await refreshSsoToken('kubepilot-d-906600a9b0', { oidc, now: () => later });
    assert.equal(r.status, 'refreshed');
    assert.deepEqual(oidc.calls[0].input, {
      clientId: 'cid-1',
      clientSecret: 'secret-1',
      grantType: 'refresh_token',
      refreshToken: 'refresh-1',
    });
    assert.equal(readCache('kubepilot-d-906600a9b0').refreshToken, 'refresh-2');
    assert.equal(readCache(START).accessToken, 'access-2', 'start-URL copy kept in step');
    // The old refresh token is now rejected → the session needs a browser sign-in.
    const tok = readCache('kubepilot-d-906600a9b0');
    fs.writeFileSync(
      cacheFile('kubepilot-d-906600a9b0'),
      JSON.stringify({
        ...tok,
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    );
    assert.equal((await refreshSsoToken('kubepilot-d-906600a9b0', { oidc })).status, 'expired');
    assert.equal((await refreshSsoToken('nope', { oidc })).status, 'missing');
    fs.writeFileSync(
      cacheFile('legacy'),
      JSON.stringify(
        tokenCacheDoc({ ...result, refreshToken: undefined }, { now: () => Date.now() - 7200_000 })
      )
    );
    assert.equal((await refreshSsoToken('legacy', { oidc })).status, 'no-refresh');
  });

  test('the AWS SDK reads our session and renews it itself (sso-session format compatibility)', async () => {
    adoptSsoLogin(result);
    const { fromSso } = await import('@aws-sdk/token-providers');
    const fresh = await fromSso({ profile: 'sso-241533118296', ignoreCache: true })();
    assert.equal(fresh.token, 'access-1');

    // Expired access token: the SDK must refresh it with our stored refresh token.
    const tok = readCache('kubepilot-d-906600a9b0');
    fs.writeFileSync(
      cacheFile('kubepilot-d-906600a9b0'),
      JSON.stringify({ ...tok, expiresAt: new Date(Date.now() - 60_000).toISOString() })
    );
    const seen = [];
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            accessToken: 'access-from-sdk',
            expiresIn: 3600,
            refreshToken: 'refresh-from-sdk',
            tokenType: 'Bearer',
          })
        );
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    try {
      const renewed = await fromSso({
        profile: 'sso-241533118296',
        ignoreCache: true,
        clientConfig: { endpoint: `http://127.0.0.1:${fake.address().port}` },
      })();
      assert.equal(renewed.token, 'access-from-sdk');
      assert.equal(seen[0].url, '/token');
      assert.deepEqual(
        {
          grantType: seen[0].body.grantType,
          refreshToken: seen[0].body.refreshToken,
          clientId: seen[0].body.clientId,
        },
        { grantType: 'refresh_token', refreshToken: 'refresh-1', clientId: 'cid-1' }
      );
      assert.equal(readCache('kubepilot-d-906600a9b0').refreshToken, 'refresh-from-sdk');
    } finally {
      fake.close();
    }
  });
});
