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
  ensureAccountSession,
  accountSessionName,
  ownsSignIn,
  isManagedSession,
  splitByAccount,
  SSO_PROBE_REGIONS,
  upsertSsoProfile,
  profileSsoInfo,
  sessionsForProfiles,
  saveAwsConfig,
  adoptSsoLogin,
  refreshSsoToken,
  sessionTokenState,
  tokenCacheDoc,
  setProfileSession,
  removeUnusedSession,
  signOutSession,
  REGISTERED_REDIRECT_URI,
  resultPage,
} from '../lib/aws-sso.mjs';

const START = 'https://d-906600a9b0.awsapps.com/start';
// One sign-in per account: the session of account 241533118296 on that portal.
const ACCT = 'kubepilot-d-906600a9b0-241533118296';
const b64url = (b) => Buffer.from(b).toString('base64url');
const get = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
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
    // A portal address pasted without its path gets "/start"; nothing else is touched.
    assert.equal(normalizeStartUrl('https://d-1.awsapps.com'), 'https://d-1.awsapps.com/start');
    assert.equal(normalizeStartUrl('https://my-org.awsapps.com/'), 'https://my-org.awsapps.com/start');
    assert.equal(normalizeStartUrl('https://d-1.awsapps.com/custom'), 'https://d-1.awsapps.com/custom');
    assert.equal(normalizeStartUrl('https://sso.example.com'), 'https://sso.example.com');
    assert.equal(normalizeStartUrl(''), '');
    assert.equal(sessionNameFor(START), 'kubepilot-d-906600a9b0');
    assert.equal(accountSessionName(START, '241533118296'), ACCT);
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
    // Off the code-carrying URL onto a clean one.
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/oauth/complete');
    assert.deepEqual(await cb.result, { code: 'the-code' });
    // The app finishing first must not take the page away from the browser.
    cb.close();
    const done = await get(cb.redirectUri.replace('/oauth/callback', '/oauth/complete'));
    assert.equal(done.status, 200);
    assert.match(done.body, /signed in to AWS/);
    assert.doesNotMatch(done.body, /the-code/);
    assert.match(done.headers['content-security-policy'], /default-src 'none'/);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      get(`${cb.redirectUri}?code=again&state=good-state`),
      /ECONNREFUSED|socket hang up|ECONNRESET/
    );
  });

  test('result page: every colour follows the theme (no fixed white card in dark mode)', () => {
    const html = resultPage(true);
    const dark = html.indexOf('@media (prefers-color-scheme:dark){:root{');
    assert.ok(dark > 0, 'dark theme overrides the colour variables');
    assert.ok(html.slice(dark).includes('--card:#161b22'));
    assert.ok(html.includes('.card{') && html.includes('background:var(--card)'));
    // No hard-coded light background outside the variable definitions.
    assert.ok(!html.includes('background:#fff'));
    assert.ok(resultPage(false, '<b>x</b>').includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  test('callback: AWS error, timeout and cancel', async () => {
    const denied = await startCallbackServer({ state: 's1' });
    const redirect = await get(
      `${denied.redirectUri}?error=access_denied&error_description=User%20denied&state=s1`
    );
    assert.equal(redirect.status, 303);
    const page = await get(denied.redirectUri.replace('/oauth/callback', '/oauth/complete'));
    assert.match(page.body, /didn’t finish/);
    assert.match(page.body, /User denied/);
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
// Every sign-in first confirms the region with a device authorization.
const DEVICE = () => ({ deviceCode: 'd', userCode: 'U', verificationUri: 'https://device', interval: 1, expiresIn: 600 });
const onlyIn = (right) => (input, region) => {
  if (region !== right) throw awsErr('InvalidRequestException', 'UnknownError');
  return DEVICE();
};

describe('sign-in manager', () => {
  test('browser (PKCE): registers for authorization_code + refresh, exchanges the code with the verifier', async () => {
    const oidc = fakeOidc({
      RegisterClientCommand: () => REG,
      StartDeviceAuthorizationCommand: DEVICE,
      CreateTokenCommand: () => TOKENS,
    });
    const login = createSsoLogin({ oidc, browserAvailable: true });
    const snap = await login.start({ startUrl: `${START}/`, ssoRegion: 'us-east-1' });
    assert.equal(snap.status, 'pending');
    assert.equal(snap.method, 'browser');
    // The saved region was right: no other region is asked.
    assert.deepEqual([...new Set(oidc.calls.map((c) => c.region))], ['us-east-1']);
    const reg = oidc.calls.filter((c) => c.name === 'RegisterClientCommand').at(-1).input;
    assert.deepEqual(reg, {
      clientName: 'k8board',
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
    const oidc = fakeOidc({ RegisterClientCommand: () => REG, StartDeviceAuthorizationCommand: DEVICE, CreateTokenCommand: () => TOKENS });
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

  test('the region is found from the start URL: a wrong saved region is corrected, every region is asked', async () => {
    assert.equal(new Set(SSO_PROBE_REGIONS).size, SSO_PROBE_REGIONS.length);
    for (const r of ['us-east-1', 'eu-west-1', 'ap-northeast-2', 'me-south-1', 'af-south-1']) assert.ok(SSO_PROBE_REGIONS.includes(r), r);
    // Saved region us-east-1, but this portal lives in ap-northeast-2.
    const oidc = fakeOidc({ RegisterClientCommand: () => REG, StartDeviceAuthorizationCommand: onlyIn('ap-northeast-2'), CreateTokenCommand: () => TOKENS });
    const login = createSsoLogin({ oidc, browserAvailable: true });
    const snap = await login.start({ startUrl: START, ssoRegion: 'us-east-1' });
    assert.deepEqual([snap.status, snap.ssoRegion], ['pending', 'ap-northeast-2']);
    assert.equal(new URL(snap.authUrl).host, 'oidc.ap-northeast-2.amazonaws.com');
    assert.equal(oidc.calls[0].region, 'us-east-1', 'the saved region is tried first');
    login.cancel();
    // No saved region: found the same way.
    const none = await login.start({ startUrl: START });
    assert.equal(none.ssoRegion, 'ap-northeast-2');
    login.cancel();
  });

  test('a start URL no region knows, and no network, say so in plain words', async () => {
    const nowhere = fakeOidc({ RegisterClientCommand: () => REG, StartDeviceAuthorizationCommand: onlyIn('nowhere') });
    const bad = await createSsoLogin({ oidc: nowhere, browserAvailable: true }).start({ startUrl: START, ssoRegion: 'eu-west-1' });
    assert.deepEqual([bad.status, bad.errorCode], ['error', 'bad_start_url']);
    assert.match(bad.error, /didn’t recognise this start URL.*usually ends in \/start/);
    assert.doesNotMatch(bad.error, /UnknownError/);
    const offline = fakeOidc({ RegisterClientCommand: () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND oidc.us-east-1.amazonaws.com'), { code: 'ENOTFOUND' }); } });
    const off = await createSsoLogin({ oidc: offline, browserAvailable: true }).start({ startUrl: START });
    assert.deepEqual([off.status, off.errorCode], ['error', 'offline']);
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

  test('each account gets its own session; the user\'s own session is never reused for it', () => {
    const a = ensureAccountSession(LEGACY, { startUrl: START, ssoRegion: 'us-east-1', accountId: '241533118296' });
    assert.deepEqual([a.created, a.name], [true, ACCT]);
    assert.match(
      a.text,
      /\[sso-session kubepilot-d-906600a9b0-241533118296\]\nsso_start_url = https:\/\/d-906600a9b0\.awsapps\.com\/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access/
    );
    // Asked again: the same one. Another account: another one.
    assert.deepEqual(ensureAccountSession(a.text, { startUrl: START, ssoRegion: 'us-east-1', accountId: '241533118296' }), { text: a.text, name: ACCT, created: false });
    assert.equal(ensureAccountSession(a.text, { startUrl: START, ssoRegion: 'us-east-1', accountId: '111122223333' }).name, 'kubepilot-d-906600a9b0-111122223333');
    // A session the user made (aws configure sso) for the same portal is left to the user.
    const mine = `[sso-session corp]\nsso_start_url = ${START}\nsso_region = us-east-1\n`;
    assert.deepEqual([ensureAccountSession(mine, { startUrl: START, ssoRegion: 'us-east-1', accountId: '241533118296' }).name, isManagedSession('corp'), isManagedSession(ACCT)], [ACCT, false, true]);
    // The name is taken by another portal's session: the next free one.
    const clash = `[sso-session ${ACCT}]\nsso_start_url = https://elsewhere.awsapps.com/start\nsso_region = us-east-1\n`;
    assert.equal(ensureAccountSession(clash, { startUrl: START, ssoRegion: 'us-east-1', accountId: '241533118296' }).name, `${ACCT}-2`);
    // A profile without an account id: the portal's name alone.
    assert.equal(ensureAccountSession('', { startUrl: START, ssoRegion: 'us-east-1' }).name, 'kubepilot-d-906600a9b0');
  });

  test('split by account: legacy profiles get their account\'s session; everything else is untouched; twice is a no-op', () => {
    assert.deepEqual(splitByAccount(LEGACY, { managedOnly: true }).moved, [], 'the user\'s own profiles move only when asked');
    const out = splitByAccount(LEGACY);
    assert.deepEqual(out.moved, [
      { profile: 'sso-241533118296', from: null, to: ACCT },
      { profile: 'other-portal', from: null, to: 'kubepilot-d-other-111111111111' },
    ]);
    assert.deepEqual(out.removedSessions, []);
    const cfg = parseAwsConfig(out.text);
    assert.deepEqual(cfg.sections.get('profile:sso-241533118296').values, {
      sso_session: ACCT,
      sso_account_id: '241533118296',
      sso_role_name: 'AdministratorAccess',
      region: 'eu-west-1',
      s3: '',
    });
    assert.match(out.text, /^# my AWS config/);
    assert.match(out.text, /s3 =\n {2}max_concurrent_requests = 20/);
    assert.equal(cfg.sections.get('sso-session:kubepilot-d-other-111111111111').values.sso_start_url, 'https://d-other.awsapps.com/start');
    assert.deepEqual(splitByAccount(out.text).moved, []);
    const info = profileSsoInfo(out.text, 'sso-241533118296');
    assert.deepEqual(info, {
      profile: 'sso-241533118296',
      sessionName: ACCT,
      startUrl: START,
      ssoRegion: 'us-east-1',
      accountId: '241533118296',
      roleName: 'AdministratorAccess',
    });
    assert.equal(ownsSignIn(info), true);
    assert.equal(ownsSignIn(profileSsoInfo(LEGACY, 'sso-241533118296')), false);
    assert.equal(profileSsoInfo(LEGACY, 'other-portal').sessionName, null);
    assert.equal(profileSsoInfo(LEGACY, 'default'), null);
    assert.deepEqual(sessionsForProfiles(out.text, ['sso-241533118296', 'nope']), [ACCT]);
  });

  test('split by account: sessions K8Board made (shared, "-production") are split and removed; the user\'s own only on request', () => {
    const text = [
      '[sso-session kubepilot-d-906600a9b0]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[sso-session kubepilot-d-906600a9b0-production]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[sso-session corp]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[profile dev]', 'sso_session = kubepilot-d-906600a9b0', 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
      '[profile dev-readonly]', 'sso_session = kubepilot-d-906600a9b0', 'sso_account_id = 111122223333', 'sso_role_name = ReadOnly', '',
      '[profile qa]', 'sso_session = kubepilot-d-906600a9b0', 'sso_account_id = 222233334444', 'sso_role_name = Dev', '',
      '[profile prod]', 'sso_session = kubepilot-d-906600a9b0-production', 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
      '[profile mine]', 'sso_session = corp', 'sso_account_id = 777788889999', 'sso_role_name = Admin', '',
      '[profile keys]', 'region = us-east-1', '',
    ].join('\n');
    const out = splitByAccount(text, { managedOnly: true });
    const session = (name) => parseAwsConfig(out.text).sections.get(`profile:${name}`).values.sso_session;
    // Two roles of one account share that account's sign-in; other accounts have their own.
    assert.deepEqual(['dev', 'dev-readonly', 'qa', 'prod', 'mine'].map(session), [
      'kubepilot-d-906600a9b0-111122223333', 'kubepilot-d-906600a9b0-111122223333', 'kubepilot-d-906600a9b0-222233334444',
      'kubepilot-d-906600a9b0-444455556666', 'corp',
    ]);
    assert.deepEqual(out.removedSessions.sort(), ['kubepilot-d-906600a9b0', 'kubepilot-d-906600a9b0-production']);
    const sections = parseAwsConfig(out.text).sections;
    assert.deepEqual(['kubepilot-d-906600a9b0', 'kubepilot-d-906600a9b0-production', 'corp'].map((n) => sections.has(`sso-session:${n}`)), [false, false, true]);
    assert.equal(sections.get('profile:keys').values.region, 'us-east-1');
    assert.deepEqual(splitByAccount(out.text, { managedOnly: true }).moved, [], 'already one per account');
    // On request: the user's profile moves too; the user's session stays in the file.
    const asked = splitByAccount(out.text, { profiles: ['mine'] });
    assert.deepEqual(asked.moved, [{ profile: 'mine', from: 'corp', to: 'kubepilot-d-906600a9b0-777788889999' }]);
    assert.deepEqual([asked.removedSessions, parseAwsConfig(asked.text).sections.has('sso-session:corp')], [[], true]);
  });

  test('a profile moves to another session (from either format); an unused session block is dropped', () => {
    const text = [
      '[sso-session kubepilot-d-906600a9b0-production]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[profile legacy]', `sso_start_url = ${START}`, 'sso_region = us-east-1', 'sso_account_id = 444455556666', 'sso_role_name = Admin', 'region = eu-west-1', '',
      '[profile kept]', 'region = us-east-1', '',
    ].join('\n');
    const moved = setProfileSession(text, 'legacy', 'kubepilot-d-906600a9b0-production');
    const p = parseAwsConfig(moved).sections.get('profile:legacy').values;
    assert.deepEqual(p, { sso_session: 'kubepilot-d-906600a9b0-production', sso_account_id: '444455556666', sso_role_name: 'Admin', region: 'eu-west-1' });
    assert.equal(removeUnusedSession(moved, 'kubepilot-d-906600a9b0-production'), moved, 'still in use: kept');
    const back = setProfileSession(moved, 'legacy', 'kubepilot-d-906600a9b0');
    const cleaned = removeUnusedSession(back, 'kubepilot-d-906600a9b0-production');
    assert.equal(parseAwsConfig(cleaned).sections.has('sso-session:kubepilot-d-906600a9b0-production'), false);
    assert.equal(parseAwsConfig(cleaned).sections.get('profile:kept').values.region, 'us-east-1', 'everything else stays');
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
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.k8board-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'original\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a backup from before the rename (.kubepilot-backup-…) counts as the backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-awscfg-'));
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, 'original\n');
    fs.writeFileSync(path.join(dir, 'config.kubepilot-backup-20261001-120000'), 'original\n');
    saveAwsConfig(file, 'v2\n');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('-backup-')), ['config.kubepilot-backup-20261001-120000']);
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

  test('adopt for a profile: its account\'s session, only that profile changed, a refreshable token for that session only', () => {
    fs.appendFileSync(process.env.AWS_CONFIG_FILE, `\n[profile other-account]\nsso_start_url = ${START}\nsso_region = us-east-1\nsso_account_id = 111122223333\nsso_role_name = Dev\n`);
    const out = adoptSsoLogin(result, { profile: 'sso-241533118296' });
    assert.deepEqual(out, { sessionName: ACCT, converted: ['sso-241533118296'], created: true });
    // The other account's profile is untouched, and nothing is copied to the start-URL cache it reads.
    const other = parseAwsConfig(fs.readFileSync(process.env.AWS_CONFIG_FILE, 'utf8')).sections.get('profile:other-account').values;
    assert.equal(other.sso_start_url, START);
    assert.equal(other.sso_session, undefined);
    assert.equal(fs.existsSync(cacheFile(START)), false, 'no start-URL copy');
    const cfg = parseAwsConfig(fs.readFileSync(process.env.AWS_CONFIG_FILE, 'utf8'));
    assert.equal(cfg.sections.get('profile:sso-241533118296').values.sso_session, ACCT);
    const tok = readCache(ACCT);
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
    assert.equal(
      fs.readdirSync(path.join(home, '.aws')).filter((f) => f.startsWith('config.k8board-backup-')).length,
      1
    );
    assert.equal(sessionTokenState(ACCT).refreshable, true);
    // Signing in again for the same profile: the same session, nothing to change.
    assert.deepEqual(adoptSsoLogin(result, { profile: 'sso-241533118296' }), { sessionName: ACCT, converted: [], created: false });
  });

  test('adopt for an account (the add-cluster wizard): that account\'s session, no profile changed', () => {
    const out = adoptSsoLogin(result, { accountId: '999900001111' });
    assert.deepEqual(out, { sessionName: 'kubepilot-d-906600a9b0-999900001111', converted: [], created: true });
    assert.equal(parseAwsConfig(fs.readFileSync(process.env.AWS_CONFIG_FILE, 'utf8')).sections.get('profile:sso-241533118296').values.sso_session, undefined);
    assert.equal(sessionTokenState('kubepilot-d-906600a9b0-999900001111').signedIn, true);
    assert.equal(sessionTokenState(ACCT).signedIn, false, 'no other account is signed in');
  });

  test('one sign-in per account: signing in for one account never reaches another, even on the same portal', () => {
    fs.writeFileSync(process.env.AWS_CONFIG_FILE, [
      '[sso-session kubepilot-d-906600a9b0]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[sso-session corp]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
      '[profile dev]', 'sso_session = kubepilot-d-906600a9b0', 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
      '[profile prod]', 'sso_session = kubepilot-d-906600a9b0', 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
      '[profile mine]', 'sso_session = corp', 'sso_account_id = 777788889999', 'sso_role_name = Admin', '',
    ].join('\n'));
    const DEV = 'kubepilot-d-906600a9b0-111122223333';
    const PROD = 'kubepilot-d-906600a9b0-444455556666';
    const sections = () => parseAwsConfig(fs.readFileSync(process.env.AWS_CONFIG_FILE, 'utf8')).sections;
    // dev shared a session with prod: it moves to its own account's, and only it is signed in.
    assert.deepEqual(adoptSsoLogin(result, { profile: 'dev' }), { sessionName: DEV, converted: ['dev'], created: true });
    assert.equal(sessionTokenState(DEV).signedIn, true);
    assert.equal(sessionTokenState(PROD).signedIn, false, 'the dev sign-in did not reach prod');
    assert.equal(sessionTokenState('kubepilot-d-906600a9b0').signedIn, false, 'nor the session they used to share');
    assert.equal(sections().get('profile:prod').values.sso_session, 'kubepilot-d-906600a9b0', 'prod is not changed by a dev sign-in');
    const prod = adoptSsoLogin({ ...result, accessToken: 'access-prod' }, { profile: 'prod' });
    assert.equal(prod.sessionName, PROD);
    assert.equal(readCache(PROD).accessToken, 'access-prod');
    assert.equal(readCache(DEV).accessToken, 'access-1', 'and the prod sign-in did not touch dev');
    assert.equal(sections().has('sso-session:kubepilot-d-906600a9b0'), false, 'the shared session is gone once nothing uses it');
    // A profile on a session the user made keeps it.
    assert.deepEqual(adoptSsoLogin(result, { profile: 'mine' }), { sessionName: 'corp', converted: [], created: false });
    assert.equal(sections().get('profile:mine').values.sso_session, 'corp');
  });

  test('sign-out: the session\'s token is gone (and an old start-URL copy of the same sign-in)', () => {
    adoptSsoLogin(result, { profile: 'sso-241533118296' });
    fs.writeFileSync(cacheFile(START), JSON.stringify(readCache(ACCT))); // as older versions wrote it
    assert.deepEqual(signOutSession(ACCT), { signedOut: true });
    assert.equal(fs.existsSync(cacheFile(ACCT)), false);
    assert.equal(fs.existsSync(cacheFile(START)), false);
    assert.equal(sessionTokenState(ACCT).signedIn, false);
    assert.deepEqual(signOutSession(ACCT), { signedOut: false });
  });

  test('renewal: only near expiry, rotates the refresh token, reports a finished session as expired', async () => {
    adoptSsoLogin(result, { profile: 'sso-241533118296' });
    // AWS rotates refresh tokens: only the latest one is accepted.
    let valid = 'refresh-1';
    const oidc = fakeOidc({
      CreateTokenCommand: (input) => {
        if (input.refreshToken !== valid) throw awsErr('InvalidGrantException');
        valid = 'refresh-2';
        return { accessToken: 'access-2', expiresIn: 3600, refreshToken: 'refresh-2' };
      },
    });
    assert.equal((await refreshSsoToken(ACCT, { oidc })).status, 'fresh');
    assert.equal(oidc.calls.length, 0);
    const later = Date.now() + 50 * 60 * 1000; // 10 minutes left
    const r = await refreshSsoToken(ACCT, { oidc, now: () => later });
    assert.equal(r.status, 'refreshed');
    assert.deepEqual(oidc.calls[0].input, {
      clientId: 'cid-1',
      clientSecret: 'secret-1',
      grantType: 'refresh_token',
      refreshToken: 'refresh-1',
    });
    assert.equal(readCache(ACCT).refreshToken, 'refresh-2');
    assert.equal(fs.existsSync(cacheFile(START)), false, 'renewing a session never writes a start-URL copy');
    // The old refresh token is now rejected → the session needs a browser sign-in.
    const tok = readCache(ACCT);
    fs.writeFileSync(
      cacheFile(ACCT),
      JSON.stringify({
        ...tok,
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    );
    assert.equal(sessionTokenState(ACCT).refreshable, true, 'a stored refresh token looks renewable until tried');
    assert.equal((await refreshSsoToken(ACCT, { oidc })).status, 'expired');
    // The refusal is remembered: the sign-in is shown as over, not "renews when opened".
    assert.deepEqual(
      [sessionTokenState(ACCT).refreshable, sessionTokenState(ACCT).renewalRefused],
      [false, true]
    );
    // A new sign-in writes a new token, which is renewable again.
    adoptSsoLogin(result, { profile: 'sso-241533118296' });
    assert.deepEqual(
      [sessionTokenState(ACCT).refreshable, sessionTokenState(ACCT).renewalRefused],
      [true, false]
    );
    assert.equal((await refreshSsoToken('nope', { oidc })).status, 'missing');
    fs.writeFileSync(
      cacheFile('legacy'),
      JSON.stringify(
        tokenCacheDoc({ ...result, refreshToken: undefined }, { now: () => Date.now() - 7200_000 })
      )
    );
    assert.equal((await refreshSsoToken('legacy', { oidc })).status, 'no-refresh');
  });

  test('a token whose client registration has run out is not renewable, without asking AWS', async () => {
    adoptSsoLogin(result, { profile: 'sso-241533118296' });
    const tok = readCache(ACCT);
    fs.writeFileSync(cacheFile(ACCT), JSON.stringify({
      ...tok, expiresAt: new Date(Date.now() - 1000).toISOString(), registrationExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    assert.deepEqual(sessionTokenState(ACCT), {
      signedIn: false, expiresAt: readCache(ACCT).expiresAt, refreshable: false, renewalRefused: true,
    });
    const oidc = fakeOidc({ CreateTokenCommand: () => { throw new Error('not called'); } });
    assert.equal((await refreshSsoToken(ACCT, { oidc })).status, 'expired');
    assert.equal(oidc.calls.length, 0);
  });

  test('the AWS SDK reads our session and renews it itself (sso-session format compatibility)', async () => {
    adoptSsoLogin(result, { profile: 'sso-241533118296' });
    const { fromSso } = await import('@aws-sdk/token-providers');
    const fresh = await fromSso({ profile: 'sso-241533118296', ignoreCache: true })();
    assert.equal(fresh.token, 'access-1');

    // Expired access token: the SDK must refresh it with our stored refresh token.
    const tok = readCache(ACCT);
    fs.writeFileSync(
      cacheFile(ACCT),
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
      assert.equal(readCache(ACCT).refreshToken, 'refresh-from-sdk');
    } finally {
      fake.close();
    }
  });
});
