// AWS IAM Identity Center sign-in — the engine behind the AWS add-cluster
// wizard and the "AWS session expired" dialog.
//
//  * Browser sign-in (default in the desktop app): OAuth 2.0 authorization code
//    + PKCE, returning through a one-time loopback redirect
//    (http://127.0.0.1:<port>/oauth/callback) — the flow the AWS CLI uses by
//    default since 2.22. No code to confirm.
//  * Device code: the fallback, and the only option outside the desktop app
//    (a browser elsewhere can't reach this machine's 127.0.0.1).
//  * Both register the client with the sso:account:access scope, so AWS issues
//    a refresh token, and the login is stored the way `aws configure sso`
//    stores it: an [sso-session] block in ~/.aws/config, its token in
//    ~/.aws/sso/cache/<sha1(session name)>.json. The SDK (token helper, server)
//    and the AWS CLI then renew the access token without a browser until the
//    Identity Center session ends; refreshSsoToken() keeps it ahead of expiry.
//  * One sign-in per AWS account: every account has its own [sso-session]
//    ("kubepilot-<portal>-<account id>") and so its own token, expiry and
//    sign-out. Signing in for one account never signs in another, although
//    they use the same access portal. (AWS itself doesn't scope a token to an
//    account; K8Board stores and uses each one for its account only.)
//  * A sign-in is stored for one session only, and changes only the profile it
//    was made for. Profiles on a session the user created are left alone
//    unless the user asks (splitByAccount).
//
// Nothing here logs or returns tokens to callers outside the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  SSOOIDCClient,
} from '@aws-sdk/client-sso-oidc';
import { getSSOTokenFilepath } from '@smithy/shared-ini-file-loader';
import { awsRequestHandler } from './net-timeouts.mjs';

export const SSO_SCOPES = ['sso:account:access'];
export const CALLBACK_PATH = '/oauth/callback';
/** Registered redirect URI; the authorize/token requests add the port (RFC 8252 loopback). */
export const REGISTERED_REDIRECT_URI = `http://127.0.0.1${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
// Shown on AWS's sign-in approval page. (Profile names keep their
// 'kubepilot-' prefix: existing ones are reused, not duplicated.)
const CLIENT_NAME = 'k8board';

// Identity Center is regional, and the start URL doesn't say where: these are
// tried (all at once) to find the region that knows it. A region with no
// Identity Center endpoint simply doesn't answer.
export const SSO_PROBE_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1', 'mx-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
  'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7', 'ap-northeast-1', 'ap-northeast-2',
  'ap-northeast-3', 'ap-east-1', 'ap-east-2',
  'me-south-1', 'me-central-1', 'il-central-1', 'af-south-1',
];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * "https://x.awsapps.com/start/#/" → "https://x.awsapps.com/start". An
 * access-portal address pasted without its path ("https://x.awsapps.com") gets
 * "/start": AWS knows the portal only by the full URL.
 */
export function normalizeStartUrl(u) {
  let s = String(u || '').trim();
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(0, hash);
  let i = s.length;
  while (i > 0 && s[i - 1] === '/') i--;
  s = s.slice(0, i);
  return /^https:\/\/[A-Za-z0-9-]+\.awsapps\.com$/i.test(s) ? `${s}/start` : s;
}

// ---------------------------------------------------------------------------
// PKCE + the authorize URL
// ---------------------------------------------------------------------------
export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32)); // 43 chars, RFC 7636 §4.1
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export const randomState = () => b64url(crypto.randomBytes(24));

/** https://oidc.<region>.amazonaws.com/authorize?… (AWS spells the scope parameter `scopes`). */
export function buildAuthorizeUrl({ region, clientId, redirectUri, state, challenge, scopes = SSO_SCOPES }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    scopes: scopes.join(','),
    code_challenge: challenge,
  });
  return `https://oidc.${region}.amazonaws.com/authorize?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// One-time loopback callback server
// ---------------------------------------------------------------------------
export const COMPLETE_PATH = '/oauth/complete';

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** The page the browser lands on after AWS sign-in (light and dark themes). */
export function resultPage(ok, detail) {
  const title = ok ? 'You’re signed in to AWS' : 'AWS sign-in didn’t finish';
  const body = ok
    ? 'K8Board is reconnecting to your cluster. You can close this tab.'
    : esc(detail || 'Return to K8Board and try again.');
  const icon = ok
    ? '<path class="draw" d="M5 12.5 10 17l9-10"/>'
    : '<path d="M12 7.5v6M12 16.6h.01"/><circle cx="12" cy="12" r="9.2"/>';
  const [light, dark] = ok ? ['#1a7f37', '#3fb950'] : ['#cf222e', '#f85149'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · K8Board</title>
<style>
:root{color-scheme:light dark;--bg:#f6f8fa;--card:#ffffff;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--tone:${light};--tone-bg:${light}1a;--shadow:0 16px 40px rgba(31,35,40,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--muted:#9198a1;--tone:${dark};--tone-bg:${dark}24;--shadow:0 16px 40px rgba(0,0,0,.45)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif}
.card{width:min(420px,100%);padding:40px 32px 28px;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:var(--shadow);text-align:center;animation:rise .35s ease-out}
.badge{width:60px;height:60px;margin:0 auto 20px;border-radius:50%;display:grid;place-items:center;background:var(--tone-bg);color:var(--tone)}
.badge svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.draw{stroke-dasharray:24;stroke-dashoffset:24;animation:draw .5s .15s ease-out forwards}
h1{margin:0 0 8px;font-size:20px;font-weight:650;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.brand{display:inline-flex;align-items:center;gap:7px;margin-top:28px;padding-top:18px;border-top:1px solid var(--border);width:100%;justify-content:center;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.brand svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.card,.draw{animation:none}.draw{stroke-dashoffset:0}}
</style></head>
<body><main class="card" role="status"><div class="badge" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>
<h1>${title}</h1><p>${body}</p>
<div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 2v7.5M19 5l-5.2 5.2M22 12h-7.5M19 19l-5.2-5.2M12 14.5V22M10.2 13.8 5 19M9.5 12H2M10.2 10.2 5 5"/></svg>K8Board</div></main></body></html>`;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
};

/**
 * Listen on 127.0.0.1:<random port> for exactly one redirect carrying `state`.
 * Resolves { port, redirectUri, result, close }: `result` settles with
 * { code } or rejects (error from AWS, timeout, close()). Requests without
 * the right state are answered 400 and ignored, so a stray request can't end
 * the sign-in. The callback is answered with a redirect to /oauth/complete,
 * so the one-time code doesn't stay in the address bar; the server stays up
 * for that one page (at most 30 s), then closes.
 */
export function startCallbackServer({ state, timeoutMs = LOGIN_TIMEOUT_MS, lingerMs = 30_000 } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {}); // the caller may cancel before awaiting
    let done = false;
    let outcome = null; // { ok, detail } once the callback arrived
    let timer;
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    };
    const server = http.createServer((req, res) => {
      const page = (status, ok, detail) => {
        res.writeHead(status, PAGE_HEADERS);
        res.end(resultPage(ok, detail));
      };
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return page(400, false);
      }
      if (req.method === 'GET' && url.pathname === COMPLETE_PATH && outcome) {
        res.on('finish', shutdown);
        return page(200, outcome.ok, outcome.detail);
      }
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        return res.end();
      }
      const got = url.searchParams.get('state') || '';
      const a = Buffer.from(got);
      const b = Buffer.from(state);
      if (done || a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return page(400, false, 'This sign-in link is not the one K8Board is waiting for.');
      done = true;
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        const detail = url.searchParams.get('error_description') || error || 'AWS returned no authorization code.';
        outcome = { ok: false, detail };
        settle.reject(Object.assign(new Error(detail), { code: error === 'access_denied' ? 'denied' : 'sign_in_failed' }));
      } else {
        outcome = { ok: true };
        settle.resolve({ code });
      }
      // Off the callback URL (it carries the code) onto a clean one.
      res.writeHead(303, { Location: COMPLETE_PATH, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      clearTimeout(timer);
      timer = setTimeout(shutdown, lingerMs);
      timer.unref?.();
    });
    const close = () => {
      if (!done) {
        done = true;
        settle.reject(Object.assign(new Error('The sign-in was cancelled.'), { code: 'cancelled' }));
        return shutdown();
      }
      // Callback received: the browser is on its way to /oauth/complete — the
      // page (or the linger timer) closes the server, not the app finishing first.
      if (!outcome) shutdown();
    };
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        settle.reject(Object.assign(new Error('The sign-in timed out.'), { code: 'timeout' }));
        shutdown();
      }, timeoutMs);
      timer.unref?.();
      resolveStart({ port, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close });
    });
  });
}

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------
export function friendlySsoError(err) {
  const name = err?.name || '';
  const code = err?.code || '';
  if (code === 'cancelled') return { code, message: 'The sign-in was cancelled.' };
  if (code === 'timeout')
    return { code, message: 'The sign-in wasn’t finished within 5 minutes. Try again.' };
  if (code === 'denied' || name === 'AccessDeniedException')
    return {
      code: 'denied',
      message:
        'AWS denied the sign-in. If you didn’t cancel it, ask your AWS administrator whether your user may access this account.',
    };
  if (name === 'ExpiredTokenException')
    return { code: 'expired', message: 'The sign-in code expired before it was approved. Try again.' };
  if (code === 'bad_start_url' || (name === 'InvalidRequestException' && /start url|startUrl/i.test(err?.message || '')))
    return {
      code: 'bad_start_url',
      message: 'AWS didn’t recognise this start URL. Copy it from your AWS access portal; it usually ends in /start.',
    };
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
      `${err?.code || ''} ${err?.message || ''}`
    )
  )
    return {
      code: 'offline',
      message: 'K8Board couldn’t reach AWS. Check your network connection and try again.',
    };
  return {
    code: 'sign_in_failed',
    message: `AWS sign-in failed: ${String(err?.message || err).split('\n')[0]}`,
  };
}

// ---------------------------------------------------------------------------
// The login manager (one sign-in at a time — a desktop app has one user)
// ---------------------------------------------------------------------------
/**
 * createSsoLogin({ oidc, browserAvailable, now })
 *   oidc(region) → an SSOOIDCClient-like { send(command) } (injected in tests)
 *   .start({ startUrl, ssoRegion, method }) → snapshot
 *   .poll() → snapshot (device: one CreateToken attempt)
 *   .cancel()
 *   .takeResult() → the finished login's tokens + registration, once
 * Snapshot: { status: idle|pending|done|error|cancelled, method, startUrl,
 *   ssoRegion, authUrl, userCode, verificationUrl, expiresAt, error }.
 */
export function createSsoLogin({
  oidc = (region) => new SSOOIDCClient({ region, requestHandler: awsRequestHandler() }),
  browserAvailable = false,
  now = Date.now,
} = {}) {
  let cur = null;

  const snapshot = () =>
    cur
      ? {
          status: cur.status,
          method: cur.method,
          startUrl: cur.startUrl,
          ssoRegion: cur.ssoRegion,
          authUrl: cur.authUrl || undefined,
          userCode: cur.userCode || undefined,
          verificationUrl: cur.verificationUrl || undefined,
          expiresAt: cur.expiresAt ? new Date(cur.expiresAt).toISOString() : undefined,
          error: cur.error || undefined,
          errorCode: cur.errorCode || undefined,
          browserAvailable,
        }
      : { status: 'idle', browserAvailable };

  const fail = (login, err) => {
    if (cur !== login || login.status !== 'pending') return;
    const f = friendlySsoError(err);
    login.status = f.code === 'cancelled' ? 'cancelled' : 'error';
    login.error = f.message;
    login.errorCode = f.code;
  };

  const registerDevice = async (client, startUrl) => {
    const reg = await client.send(
      new RegisterClientCommand({ clientName: CLIENT_NAME, clientType: 'public', scopes: SSO_SCOPES })
    );
    const auth = await client.send(
      new StartDeviceAuthorizationCommand({
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
        startUrl,
      })
    );
    return { reg, auth };
  };

  // The region that knows this start URL, with a device authorization started
  // there (the only API that checks a start URL against a region). `hint`: the
  // region saved from an earlier sign-in, tried first; if it's wrong, or there
  // is none, every region is asked at once and the one that accepts wins.
  // Wrong regions answer InvalidRequestException; if none accepts, the URL is
  // wrong ('bad_start_url'), unless no region could be reached at all.
  const deviceStart = async (startUrl, hint) => {
    const tryRegion = async (r) => ({ region: r, ...(await registerDevice(oidc(r), startUrl)) });
    let hintErr = null;
    if (hint) {
      try {
        return await tryRegion(hint);
      } catch (e) {
        hintErr = e;
      }
    }
    try {
      return await Promise.any(SSO_PROBE_REGIONS.filter((r) => r !== hint).map(tryRegion));
    } catch (agg) {
      const errors = [hintErr, ...(agg?.errors || [agg])].filter(Boolean);
      if (errors.some((e) => e?.name === 'InvalidRequestException'))
        throw Object.assign(new Error('No AWS region recognises this start URL'), { code: 'bad_start_url' });
      throw hintErr || errors[0] || new Error('no region matched');
    }
  };

  async function start({ startUrl: rawUrl, ssoRegion, method } = {}) {
    cancel();
    const startUrl = normalizeStartUrl(rawUrl);
    if (!/^https:\/\/[A-Za-z0-9._~:/-]{1,512}$/.test(startUrl))
      throw Object.assign(
        new Error('Enter your AWS access portal (start) URL, e.g. https://<id>.awsapps.com/start.'),
        { status: 400 }
      );
    if (ssoRegion && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(ssoRegion))
      throw Object.assign(new Error('Invalid IAM Identity Center region'), { status: 400 });
    const useBrowser = method === 'device' ? false : browserAvailable;
    const login = {
      status: 'pending',
      method: useBrowser ? 'browser' : 'device',
      startUrl,
      ssoRegion: ssoRegion || null,
      startedAt: now(),
    };
    cur = login;
    try {
      if (!useBrowser) {
        const { region, reg, auth } = await deviceStart(startUrl, ssoRegion);
        Object.assign(login, {
          ssoRegion: region,
          reg,
          deviceCode: auth.deviceCode,
          userCode: auth.userCode,
          verificationUrl: auth.verificationUriComplete || auth.verificationUri,
          interval: (auth.interval || 5) * 1000,
          expiresAt: now() + (auth.expiresIn || 600) * 1000,
          nextPollAt: now(),
        });
        return snapshot();
      }
      // Browser: confirm the region first (a saved one may be wrong, and the
      // device probe is the only API that checks a start URL against a region).
      const { region } = await deviceStart(startUrl, ssoRegion);
      const client = oidc(region);
      const reg = await client.send(
        new RegisterClientCommand({
          clientName: CLIENT_NAME,
          clientType: 'public',
          grantTypes: ['authorization_code', 'refresh_token'],
          redirectUris: [REGISTERED_REDIRECT_URI],
          issuerUrl: startUrl,
          scopes: SSO_SCOPES,
        })
      );
      const { verifier, challenge } = pkcePair();
      const state = randomState();
      const cb = await startCallbackServer({ state });
      if (cur !== login) {
        cb.close();
        return snapshot();
      }
      Object.assign(login, {
        ssoRegion: region,
        reg,
        cb,
        authUrl: buildAuthorizeUrl({
          region,
          clientId: reg.clientId,
          redirectUri: cb.redirectUri,
          state,
          challenge,
        }),
        expiresAt: now() + LOGIN_TIMEOUT_MS,
      });
      cb.result.then(
        async ({ code }) => {
          if (cur !== login || login.status !== 'pending') return;
          try {
            const tok = await client.send(
              new CreateTokenCommand({
                clientId: reg.clientId,
                clientSecret: reg.clientSecret,
                grantType: 'authorization_code',
                code,
                codeVerifier: verifier,
                redirectUri: cb.redirectUri,
              })
            );
            if (cur !== login || login.status !== 'pending') return;
            login.tokens = tok;
            login.status = 'done';
          } catch (e) {
            fail(login, e);
          }
        },
        (e) => fail(login, e)
      );
      return snapshot();
    } catch (e) {
      fail(login, e);
      return snapshot();
    }
  }

  async function poll() {
    const login = cur;
    if (!login || login.status !== 'pending' || login.method !== 'device') return snapshot();
    if (now() > login.expiresAt) {
      fail(login, { name: 'ExpiredTokenException' });
      return snapshot();
    }
    if (now() < login.nextPollAt) return snapshot();
    login.nextPollAt = now() + login.interval;
    try {
      const tok = await oidc(login.ssoRegion).send(
        new CreateTokenCommand({
          clientId: login.reg.clientId,
          clientSecret: login.reg.clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: login.deviceCode,
        })
      );
      if (cur === login && login.status === 'pending') {
        login.tokens = tok;
        login.status = 'done';
      }
    } catch (e) {
      if (e?.name === 'SlowDownException') login.interval += 5000;
      else if (e?.name !== 'AuthorizationPendingException') fail(login, e);
    }
    return snapshot();
  }

  function cancel() {
    const login = cur;
    if (!login) return snapshot();
    if (login.status === 'pending') {
      login.status = 'cancelled';
      login.error = 'The sign-in was cancelled.';
      login.errorCode = 'cancelled';
    }
    login.cb?.close();
    return snapshot();
  }

  /** The finished login (tokens + registration), handed out once. */
  function takeResult() {
    const login = cur;
    if (!login || login.status !== 'done' || !login.tokens || login.taken) return null;
    login.taken = true;
    login.cb?.close();
    return {
      startUrl: login.startUrl,
      ssoRegion: login.ssoRegion,
      accessToken: login.tokens.accessToken,
      expiresIn: login.tokens.expiresIn,
      refreshToken: login.tokens.refreshToken,
      clientId: login.reg.clientId,
      clientSecret: login.reg.clientSecret,
      clientSecretExpiresAt: login.reg.clientSecretExpiresAt,
    };
  }

  return { start, poll, cancel, takeResult, snapshot };
}

// ---------------------------------------------------------------------------
// ~/.aws/config (INI) — read and minimal text edits that keep comments,
// unrelated keys and nested settings intact.
// ---------------------------------------------------------------------------
export const awsConfigPath = ({
  env = process.env,
  home = env.HOME || env.USERPROFILE || os.homedir(),
} = {}) => env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config');

const HEADER_RE = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:[#;].*)?$/;
const KEY_RE = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/;

/** Section key for a header: "profile dev" → "profile:dev", "default" → "profile:default", "sso-session x" → "sso-session:x". */
function sectionKey(header) {
  const parts = header.split(/\s+/);
  if (parts.length === 1) return parts[0] === 'default' ? 'profile:default' : `other:${parts[0]}`;
  if (parts[0] === 'profile') return `profile:${parts.slice(1).join(' ')}`;
  if (parts[0] === 'sso-session') return `sso-session:${parts.slice(1).join(' ')}`;
  return `other:${header}`;
}

/** Parse INI text into { sections: Map<key, { name, kind, values, start, end }>, lines }. */
export function parseAwsConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = new Map();
  let cur = null;
  lines.forEach((line, i) => {
    const h = line.match(HEADER_RE);
    if (h) {
      if (cur) cur.end = i;
      const key = sectionKey(h[1]);
      const [kind, ...rest] = key.split(':');
      cur = { key, kind, name: rest.join(':'), values: {}, start: i, end: lines.length };
      sections.set(key, cur);
      return;
    }
    if (!cur || /^\s/.test(line) || /^\s*[#;]/.test(line)) return; // nested / comments
    const kv = line.match(KEY_RE);
    if (kv) cur.values[kv[1]] = kv[2].trim();
  });
  return { sections, lines };
}

const profilesOf = (cfg) => [...cfg.sections.values()].filter((s) => s.kind === 'profile');

// One sign-in per AWS account. An Identity Center token reaches every account
// its user is assigned, so K8Board keeps a separate [sso-session] (its own
// token cache, expiry and sign-out) for each account, and uses a token only
// for the account it was stored for. Sessions K8Board creates are named
// "kubepilot-<portal>-<account id>"; ones the user made (aws configure sso)
// are left as they are.
export const MANAGED_SESSION_PREFIX = 'kubepilot-';
export const isManagedSession = (name) => typeof name === 'string' && name.startsWith(MANAGED_SESSION_PREFIX);
const ACCOUNT_ID_RE = /^\d{12}$/;

/** "https://d-906600a9b0.awsapps.com/start" → "kubepilot-d-906600a9b0". */
export function sessionNameFor(startUrl) {
  let label = '';
  try {
    label = new URL(startUrl).hostname.split('.')[0];
  } catch {
    /* fall back to a hash */
  }
  label = label.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `kubepilot-${label || crypto.createHash('sha1').update(String(startUrl)).digest('hex').slice(0, 10)}`;
}

/** The session of one account on a portal: "kubepilot-d-906600a9b0-123456789012". */
export const accountSessionName = (startUrl, accountId) => `${sessionNameFor(startUrl)}-${accountId}`;

/** Does this profile (profileSsoInfo) sign in with its own account's session? */
export function ownsSignIn(info) {
  if (!info?.sessionName || !info.startUrl || !ACCOUNT_ID_RE.test(info.accountId || '')) return false;
  const base = accountSessionName(info.startUrl, info.accountId);
  return info.sessionName === base || (info.sessionName.startsWith(`${base}-`) && /^\d+$/.test(info.sessionName.slice(base.length + 1)));
}

/** The SSO settings a profile resolves to (sso-session or legacy keys), or null. */
export function profileSsoInfo(text, profileName) {
  const cfg = parseAwsConfig(text);
  const p = cfg.sections.get(`profile:${profileName}`);
  if (!p) return null;
  const v = p.values;
  if (v.sso_session) {
    const s = cfg.sections.get(`sso-session:${v.sso_session}`);
    if (!s)
      return {
        profile: profileName,
        sessionName: v.sso_session,
        startUrl: null,
        ssoRegion: null,
        accountId: v.sso_account_id,
        roleName: v.sso_role_name,
      };
    return {
      profile: profileName,
      sessionName: v.sso_session,
      startUrl: normalizeStartUrl(s.values.sso_start_url),
      ssoRegion: s.values.sso_region || null,
      accountId: v.sso_account_id,
      roleName: v.sso_role_name,
    };
  }
  if (v.sso_start_url)
    return {
      profile: profileName,
      sessionName: null,
      startUrl: normalizeStartUrl(v.sso_start_url),
      ssoRegion: v.sso_region || null,
      accountId: v.sso_account_id,
      roleName: v.sso_role_name,
    };
  return null;
}

/** Session names used by these profiles (for keeping them fresh). */
export function sessionsForProfiles(text, profileNames) {
  const out = new Set();
  for (const name of profileNames) {
    const info = profileSsoInfo(text, name);
    if (info?.sessionName) out.add(info.sessionName);
  }
  return [...out];
}

const appendBlock = (text, header, lines) => {
  const body = `[${header}]\n${lines.join('\n')}\n`;
  const trimmed = String(text || '').replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${body}` : body;
};

/**
 * The [sso-session] of one AWS account on this start URL (+ region): the
 * existing "kubepilot-<portal>-<account id>" is reused, otherwise it is added.
 * Never a session shared with another account, nor one the user created.
 * Without an account id (a profile that has none) the name has no suffix.
 */
export function ensureAccountSession(text, { startUrl, ssoRegion, accountId }) {
  const url = normalizeStartUrl(startUrl);
  const cfg = parseAwsConfig(text);
  const base = ACCOUNT_ID_RE.test(accountId || '') ? accountSessionName(url, accountId) : sessionNameFor(url);
  const nameAt = (i) => `${base}${i > 1 ? `-${i}` : ''}`;
  // The first free name, unless an earlier one is already this portal's session.
  for (let i = 1; ; i++) {
    const name = nameAt(i);
    const existing = cfg.sections.get(`sso-session:${name}`);
    if (!existing) {
      return {
        text: appendBlock(text, `sso-session ${name}`, [
          `sso_start_url = ${url}`,
          `sso_region = ${ssoRegion}`,
          `sso_registration_scopes = ${SSO_SCOPES.join(',')}`,
        ]),
        name,
        created: true,
      };
    }
    if (
      normalizeStartUrl(existing.values.sso_start_url) === url &&
      (!existing.values.sso_region || existing.values.sso_region === ssoRegion)
    )
      return { text, name, created: false };
  }
}

/**
 * Give SSO profiles a sign-in of their own account: each one that shares a
 * session with other accounts (or has the legacy format) moves to its
 * account's session. `profiles`: the profile names to look at (default: all);
 * `managedOnly`: skip profiles on sessions the user created, and legacy ones.
 * Sessions K8Board made that no profile uses afterwards are removed.
 * → { text, moved: [{ profile, from, to }], removedSessions: [name] }
 */
export function splitByAccount(text, { profiles = null, managedOnly = false } = {}) {
  const names = profiles || profilesOf(parseAwsConfig(text)).map((p) => p.name);
  const moved = [];
  let next = text;
  for (const name of names) {
    const info = profileSsoInfo(next, name);
    if (!info?.startUrl || !info.ssoRegion || !ACCOUNT_ID_RE.test(info.accountId || '') || ownsSignIn(info)) continue;
    if (managedOnly && !isManagedSession(info.sessionName)) continue;
    const session = ensureAccountSession(next, {
      startUrl: info.startUrl,
      ssoRegion: info.ssoRegion,
      accountId: info.accountId,
    });
    next = setProfileSession(session.text, name, session.name);
    moved.push({ profile: name, from: info.sessionName, to: session.name });
  }
  const removedSessions = [];
  for (const from of new Set(moved.map((m) => m.from).filter(isManagedSession))) {
    const after = removeUnusedSession(next, from);
    if (after !== next) {
      next = after;
      removedSessions.push(from);
    }
  }
  return { text: next, moved, removedSessions };
}

/**
 * Point one profile at `sessionName` (sso_session = …), whichever format it
 * had; its account, role, region and other lines stay.
 */
export function setProfileSession(text, profileName, sessionName) {
  const cfg = parseAwsConfig(text);
  const p = cfg.sections.get(`profile:${profileName}`);
  if (!p) return text;
  const lines = [...cfg.lines];
  const body = lines.slice(p.start + 1, p.end).filter((l) => !/^(sso_session|sso_start_url|sso_region)\s*=/.test(l));
  lines.splice(p.start + 1, p.end - p.start - 1, `sso_session = ${sessionName}`, ...body);
  return lines.join('\n');
}

/** Drop the [sso-session] block `name` when no profile uses it any more. */
export function removeUnusedSession(text, name) {
  const cfg = parseAwsConfig(text);
  const s = cfg.sections.get(`sso-session:${name}`);
  if (!s || profilesOf(cfg).some((p) => p.values.sso_session === name)) return text;
  const lines = [...cfg.lines];
  lines.splice(s.start, s.end - s.start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Remove a profile section (`[profile name]`, or `[default]`) and its lines. */
export function removeProfile(text, name) {
  const cfg = parseAwsConfig(text);
  const p = cfg.sections.get(`profile:${name}`);
  if (!p) return text;
  const lines = [...cfg.lines];
  lines.splice(p.start, p.end - p.start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Add or replace a K8Board SSO profile that uses `sessionName`. */
export function upsertSsoProfile(text, { name, sessionName, accountId, roleName, region }) {
  const cfg = parseAwsConfig(text);
  const header = name === 'default' ? 'default' : `profile ${name}`;
  const block = [
    `sso_session = ${sessionName}`,
    `sso_account_id = ${accountId}`,
    `sso_role_name = ${roleName}`,
    region ? `region = ${region}` : null,
  ].filter(Boolean);
  const p = cfg.sections.get(`profile:${name}`);
  if (!p) return appendBlock(text, header, block);
  const lines = [...cfg.lines];
  const kept = lines
    .slice(p.start + 1, p.end)
    .filter(
      (l) => !/^(sso_session|sso_start_url|sso_region|sso_account_id|sso_role_name|region)\s*=/.test(l)
    );
  lines.splice(p.start, p.end - p.start, `[${header}]`, ...block, ...kept);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Private file writes + the token cache
// ---------------------------------------------------------------------------
export function writePrivateFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (Windows) */
  }
}

/**
 * Write the AWS config, keeping one copy of the file as it was before
 * K8Board first changed it (config.kubepilot-backup-<timestamp>).
 */
export function saveAwsConfig(file, text, { now = Date.now } = {}) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (before === text) return false;
  if (before !== null) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    // One backup is enough; an older one may still carry the name from before the rename.
    const hasBackup = fs.readdirSync(dir).some((f) => f.startsWith(`${base}.k8board-backup-`) || f.startsWith(`${base}.kubepilot-backup-`));
    if (!hasBackup) {
      const ts = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const backup = path.join(dir, `${base}.k8board-backup-${ts}`);
      fs.copyFileSync(file, backup);
      try {
        fs.chmodSync(backup, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
  writePrivateFile(file, text.endsWith('\n') ? text : `${text}\n`);
  return true;
}

/** The token cache document, in the AWS CLI's format. */
export function tokenCacheDoc(result, { now = Date.now } = {}) {
  return {
    startUrl: result.startUrl,
    region: result.ssoRegion,
    accessToken: result.accessToken,
    expiresAt: isoSeconds(now() + (result.expiresIn || 3600) * 1000),
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    ...(result.clientSecretExpiresAt
      ? { registrationExpiresAt: isoSeconds(result.clientSecretExpiresAt * 1000) }
      : {}),
    ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
  };
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Store a finished sign-in for one AWS account: `profile`'s (the "AWS session
 * expired" dialog), or `accountId` (the add-cluster wizard, once an account is
 * chosen).
 *  - The token goes to that account's session only. Signing in for one
 *    account never signs in another, and nothing is copied to the start-URL
 *    cache other (legacy) profiles read.
 *  - `profile` moves to its account's session if it shared one K8Board made,
 *    or had the legacy format. A session the user created is used as it is.
 * → { sessionName, converted, created }
 */
export function adoptSsoLogin(
  result,
  { configFile = awsConfigPath(), now = Date.now, profile = null, accountId = null } = {}
) {
  let text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const url = normalizeStartUrl(result.startUrl);
  const target = profile ? profileSsoInfo(text, profile) : null;
  const forThisUrl = target && target.startUrl === url ? target : null;
  let sessionName;
  let created = false;
  let converted = [];
  if (forThisUrl?.sessionName && (!isManagedSession(forThisUrl.sessionName) || ownsSignIn(forThisUrl))) {
    sessionName = forThisUrl.sessionName; // already its own, or the user's own session
  } else {
    const ensured = ensureAccountSession(text, {
      startUrl: url,
      ssoRegion: result.ssoRegion,
      accountId: forThisUrl?.accountId || accountId,
    });
    ({ text, name: sessionName, created } = ensured);
    if (forThisUrl) {
      const before = forThisUrl.sessionName;
      text = setProfileSession(text, profile, sessionName);
      converted = [profile];
      if (isManagedSession(before)) text = removeUnusedSession(text, before);
    }
  }
  saveAwsConfig(configFile, text, { now });
  writePrivateFile(getSSOTokenFilepath(sessionName), JSON.stringify(tokenCacheDoc(result, { now }), null, 2));
  return { sessionName, converted, created };
}

/**
 * Sign out of a session on this computer: its cached token (and refresh token)
 * is deleted, with the start-URL copy older versions wrote for the same
 * sign-in. Its clusters need a new sign-in. (The browser's AWS access-portal
 * session is not touched.) → { signedOut: boolean }
 */
export function signOutSession(sessionName) {
  const file = getSSOTokenFilepath(sessionName);
  const tok = readJson(file);
  if (!tok) return { signedOut: false };
  fs.rmSync(file, { force: true });
  if (tok.startUrl) {
    const legacy = getSSOTokenFilepath(normalizeStartUrl(tok.startUrl));
    if (legacy !== file && tok.clientId && readJson(legacy)?.clientId === tok.clientId) fs.rmSync(legacy, { force: true });
  }
  return { signedOut: true };
}

// Sessions whose refresh AWS refused (or whose client registration ran out):
// session name → the refused token's fingerprint. Only that token: a new
// sign-in writes a new refresh token, which is renewable again. In memory, so
// after a restart a session is assumed renewable until a refresh is tried.
const refusedRenewals = new Map();
const tokenFingerprint = (tok) =>
  crypto.createHash('sha256').update([tok.clientId, tok.accessToken, tok.refreshToken].map((v) => v || '').join('\0')).digest('hex').slice(0, 16);
const registrationEnded = (tok, now) => !!tok.registrationExpiresAt && Date.parse(tok.registrationExpiresAt) <= now;

/**
 * Renew a session's access token with its refresh token when less than
 * `windowMs` remains. → { status: 'fresh'|'refreshed'|'no-refresh'|'expired'|'missing'|'error', expiresAt? }
 * 'expired' means AWS refused the refresh: the Identity Center session ended
 * and a browser sign-in is needed. It is remembered for sessionTokenState().
 */
export async function refreshSsoToken(
  sessionName,
  { oidc = (region) => new SSOOIDCClient({ region, requestHandler: awsRequestHandler() }), windowMs = 15 * 60 * 1000, now = Date.now } = {}
) {
  const file = getSSOTokenFilepath(sessionName);
  const tok = readJson(file);
  if (!tok?.accessToken || !tok.expiresAt) return { status: 'missing' };
  const expiresAt = Date.parse(tok.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - now() > windowMs)
    return { status: 'fresh', expiresAt: tok.expiresAt };
  if (!tok.refreshToken || !tok.clientId || !tok.clientSecret || !tok.region)
    return { status: 'no-refresh', expiresAt: tok.expiresAt };
  const refused = () => {
    refusedRenewals.set(sessionName, tokenFingerprint(tok));
    return { status: 'expired', expiresAt: tok.expiresAt };
  };
  if (registrationEnded(tok, now())) return refused();
  try {
    const out = await oidc(tok.region).send(
      new CreateTokenCommand({
        clientId: tok.clientId,
        clientSecret: tok.clientSecret,
        grantType: 'refresh_token',
        refreshToken: tok.refreshToken,
      })
    );
    const next = {
      ...tok,
      accessToken: out.accessToken,
      expiresAt: isoSeconds(now() + (out.expiresIn || 3600) * 1000),
      refreshToken: out.refreshToken || tok.refreshToken,
    };
    // This session only: a start-URL copy (legacy profiles) is never renewed with it.
    writePrivateFile(file, JSON.stringify(next, null, 2));
    refusedRenewals.delete(sessionName);
    return { status: 'refreshed', expiresAt: next.expiresAt };
  } catch (e) {
    if (
      [
        'InvalidGrantException',
        'ExpiredTokenException',
        'UnauthorizedClientException',
        'InvalidClientException',
        'AccessDeniedException',
      ].includes(e?.name)
    )
      return refused();
    return { status: 'error', expiresAt: tok.expiresAt, error: String(e?.message || e).split('\n')[0] };
  }
}

/**
 * Local look at a session's token (no network):
 * { signedIn, expiresAt, refreshable, renewalRefused }. `renewalRefused`: this
 * token can't be renewed any more (AWS refused it, or its client registration
 * ran out), so only a new sign-in helps; `refreshable` is then false.
 */
export function sessionTokenState(sessionName, { now = Date.now } = {}) {
  const tok = readJson(getSSOTokenFilepath(sessionName));
  if (!tok?.accessToken || !tok.expiresAt) return { signedIn: false, expiresAt: null, refreshable: false, renewalRefused: false };
  const exp = Date.parse(tok.expiresAt);
  const remembered = refusedRenewals.get(sessionName);
  if (remembered && remembered !== tokenFingerprint(tok)) refusedRenewals.delete(sessionName); // signed in since
  const renewalRefused = registrationEnded(tok, now()) || refusedRenewals.has(sessionName);
  return {
    signedIn: Number.isFinite(exp) && exp > now(),
    expiresAt: tok.expiresAt,
    refreshable: !!(tok.refreshToken && tok.clientId && tok.clientSecret) && !renewalRefused,
    renewalRefused,
  };
}
