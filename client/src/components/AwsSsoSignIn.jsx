import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import { getJson, postJson, errorMessage } from '../lib/api';
import { redactSensitive } from '../lib/redact';

// AWS IAM Identity Center sign-in, used by the "AWS session expired" dialog
// and the AWS add-cluster wizard. The server (lib/aws-sso.mjs) runs the flow:
//   browser (desktop app) — AWS's sign-in page opens in the system browser and
//     returns to KubePilot through a one-time 127.0.0.1 redirect; nothing to type.
//   device code — the fallback ("Use a sign-in code instead"), and the only
//     option when KubePilot runs on a server.
// A finished sign-in is stored as a refreshable AWS session, so it renews on
// its own until the Identity Center session ends.

const POLL_MS = 1500;
const openExternal = (url) => {
  if (/^https:\/\//.test(url || '')) window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * const sso = useSsoSignIn({ onDone })
 *   sso.state.phase: idle | starting | browser | device | done | error
 *   sso.start({ profile?, startUrl?, ssoRegion?, method? })  method 'device' forces the code flow
 *   sso.switchToCode(), sso.retry(), sso.reopen(), sso.cancel()
 * A sign-in started here is cancelled on unmount (frees the loopback port).
 */
export function useSsoSignIn({ onDone } = {}) {
  const [state, setState] = useState({ phase: 'idle' });
  const params = useRef({});
  const timer = useRef(null);
  const pending = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const stateRef = useRef(state);
  stateRef.current = state;

  const stop = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };

  const apply = useCallback((s) => {
    if (s?.status === 'pending') {
      setState({
        phase: s.method === 'browser' ? 'browser' : 'device',
        method: s.method,
        authUrl: s.authUrl,
        userCode: s.userCode,
        verificationUrl: s.verificationUrl,
        expiresAt: s.expiresAt,
        startUrl: s.startUrl,
        browserAvailable: s.browserAvailable,
      });
      return 'pending';
    }
    pending.current = false;
    if (s?.status === 'done') {
      setState({ phase: 'done', converted: s.converted || [], warning: s.warning });
      onDoneRef.current?.(s);
      return 'done';
    }
    if (s?.status === 'cancelled' || s?.status === 'idle') {
      setState({ phase: 'idle' });
      return 'idle';
    }
    setState((prev) => ({
      phase: 'error',
      error: s?.error || 'AWS sign-in failed.',
      errorCode: s?.errorCode,
      method: s?.method || prev.method,
      browserAvailable: s?.browserAvailable ?? prev.browserAvailable,
    }));
    return 'error';
  }, []);

  const poll = useCallback(() => {
    stop();
    timer.current = setTimeout(async () => {
      try {
        if (apply(await getJson('/api/aws/sso-login/status')) === 'pending') poll();
      } catch {
        if (pending.current) poll(); // transient network blip: keep waiting
      }
    }, POLL_MS);
  }, [apply]);

  const start = useCallback(
    async (p = {}) => {
      params.current = p;
      stop();
      setState({ phase: 'starting', method: p.method });
      try {
        const s = await postJson('/api/aws/sso-login', {
          profile: p.profile || undefined,
          startUrl: p.startUrl || undefined,
          ssoRegion: p.ssoRegion || undefined,
          method: p.method || undefined,
        });
        pending.current = s?.status === 'pending';
        const snap = s?.status
          ? s
          : s?.userCode
            ? { ...s, status: 'pending', method: 'device' }
            : { status: 'error', error: s?.error };
        if (apply(snap) === 'pending') {
          openExternal(snap.method === 'browser' ? snap.authUrl : snap.verificationUrl);
          poll();
        }
      } catch (e) {
        pending.current = false;
        setState({ phase: 'error', error: errorMessage(e, 'AWS sign-in could not start.') });
      }
    },
    [apply, poll]
  );

  const switchToCode = useCallback(() => start({ ...params.current, method: 'device' }), [start]);
  const retry = useCallback(() => start(params.current), [start]);
  const reopen = useCallback(() => {
    const s = stateRef.current;
    openExternal(s.phase === 'browser' ? s.authUrl : s.verificationUrl);
  }, []);
  const cancel = useCallback(() => {
    stop();
    if (pending.current) {
      pending.current = false;
      postJson('/api/aws/sso-login/cancel').catch(() => {});
    }
    setState({ phase: 'idle' });
  }, []);

  useEffect(
    () => () => {
      stop();
      if (pending.current) postJson('/api/aws/sso-login/cancel').catch(() => {});
    },
    []
  );

  return { state, start, switchToCode, retry, reopen, cancel };
}

/** "Expires in 4:32" — ticks every second; nothing once expired. */
function Countdown({ expiresAt, prefix = 'Expires in' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  return (
    <span className="sso-countdown">
      {prefix} {m}:{s}
    </span>
  );
}

function CopyButton({ text, label = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? 'check' : 'copy'}
      className={`sso-copy ${className}`.trim()}
      onClick={copy}
      aria-live="polite"
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

/**
 * The sign-in area: one primary action, then each step in place. It never
 * displays environment details (portal address, account): the command is
 * shown masked and copied in full.
 *   <SsoSignInPanel sso={useSsoSignIn(…)} params={{ profile }}
 *     browser={true|false|undefined} command="aws sso login --profile x" doneText="Reconnecting…" />
 */
export function SsoSignInPanel({
  sso,
  params = {},
  browser,
  command,
  doneText = 'Reconnecting…',
  startLabel = 'Sign in with AWS',
}) {
  const { state } = sso;
  const codeOnly = browser === false;

  if (state.phase === 'browser') {
    return (
      <div className="sso-panel sso-waiting" data-phase="browser">
        <div className="sso-orb" aria-hidden="true">
          <span className="sso-orb-ring" />
          <Icon name="externalLink" size={20} />
        </div>
        <div className="sso-wait-text" role="status" aria-live="polite">
          <strong>Finish signing in in your browser</strong>
          <span>Approve the request on your AWS access portal. KubePilot reconnects on its own.</span>
          {state.expiresAt && <Countdown expiresAt={state.expiresAt} prefix="Waiting · expires in" />}
        </div>
        <div className="sso-actions">
          <Button variant="secondary" size="sm" icon="externalLink" onClick={sso.reopen}>
            Open sign-in page again
          </Button>
          <Button variant="ghost" size="sm" onClick={sso.switchToCode}>
            Use a code instead
          </Button>
          <Button variant="ghost" size="sm" onClick={sso.cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'device') {
    return (
      <div className="sso-panel sso-device" data-phase="device">
        <span className="sso-eyebrow">Confirm this code on the AWS page</span>
        <div className="sso-code-row">
          <code className="sso-code" aria-label={`Sign-in code ${state.userCode}`}>
            {state.userCode}
          </code>
          <CopyButton text={state.userCode || ''} />
        </div>
        <div className="sso-actions">
          <Button variant="primary" size="sm" icon="externalLink" onClick={sso.reopen}>
            Open sign-in page
          </Button>
          <Button variant="ghost" size="sm" onClick={sso.cancel}>
            Cancel
          </Button>
        </div>
        <div className="sso-waiting-line" role="status" aria-live="polite">
          <span className="sso-pulse" aria-hidden="true" />
          <span>Waiting for approval…</span>
          {state.expiresAt && <Countdown expiresAt={state.expiresAt} prefix="Code expires in" />}
        </div>
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="sso-panel sso-done" data-phase="done" role="status" aria-live="polite">
        <span className="sso-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M5 12.5 10 17l9-10" />
          </svg>
        </span>
        <div className="sso-wait-text">
          <strong>Signed in to AWS</strong>
          <span>{doneText}</span>
          {state.warning ? (
            <span className="sso-note sso-note-warn">{redactSensitive(state.warning)}</span>
          ) : (
            <span className="sso-note">Your sign-in now renews automatically until your AWS session ends.</span>
          )}
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="sso-panel sso-error" data-phase="error">
        <div className="sso-error-msg" role="alert">
          <Icon name="warning" size={15} /> <span>{redactSensitive(state.error)}</span>
        </div>
        <div className="sso-actions">
          <Button variant="primary" size="sm" icon="refresh" onClick={sso.retry}>
            Try again
          </Button>
          {state.method !== 'device' && !codeOnly && (
            <Button variant="ghost" size="sm" onClick={sso.switchToCode}>
              Use a sign-in code instead
            </Button>
          )}
        </div>
      </div>
    );
  }

  // idle / starting
  const starting = state.phase === 'starting';
  return (
    <div className="sso-panel sso-idle" data-phase={state.phase}>
      <Button
        variant="primary"
        size="lg"
        icon="aws"
        className="sso-primary"
        busy={starting}
        onClick={() => sso.start(params)}
      >
        {starting ? 'Opening AWS sign-in…' : startLabel}
      </Button>
      <p className="sso-hint">
        {codeOnly
          ? 'Shows a code to confirm on your AWS access portal in your browser.'
          : 'Opens your AWS access portal in your browser — you’ll come straight back here.'}
      </p>
      <div className="sso-alt">
        {!codeOnly && (
          <button
            type="button"
            className="sso-link"
            disabled={starting}
            onClick={() => sso.start({ ...params, method: 'device' })}
          >
            Use a sign-in code instead
          </button>
        )}
        {command && (
          <span className="sso-cli">
            {!codeOnly && (
              <span className="sso-sep" aria-hidden="true">
                ·
              </span>
            )}
            or run <code>{redactSensitive(command)}</code>
            <CopyButton text={command} />
          </span>
        )}
      </div>
    </div>
  );
}

export default SsoSignInPanel;
