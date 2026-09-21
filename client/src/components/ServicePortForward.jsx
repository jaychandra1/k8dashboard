import { useId, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import useRequest from '../hooks/useRequest';
import { getJson, postJson, del, p, errorMessage } from '../lib/api';

const PORT_MIN = 1;
const PORT_MAX = 65535;

/** '' → null (random port); otherwise an error string or null. */
export function validatePort(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || !Number.isInteger(n)) return 'Port must be a whole number.';
  if (n < PORT_MIN || n > PORT_MAX) return `Port must be between ${PORT_MIN} and ${PORT_MAX}.`;
  return null;
}

/** Warning for privileged ports (still allowed). */
export const portWarning = (v) => (v !== '' && v != null && !validatePort(v) && Number(v) < 1024 ? 'Ports below 1024 usually need elevated privileges.' : null);

const friendlyError = (err) => {
  if (err?.code === 'too_many_port_forwards' || err?.status === 429) return 'Too many active port-forwards. Stop one before starting another.';
  if (err?.code === 'invalid_param') return `${errorMessage(err)}${err?.body?.field ? ` (${err.body.field})` : ''}`;
  return errorMessage(err, 'Port-forward failed');
};

export default function ServicePortForward({ namespace, name, ports = [], onClose }) {
  const uid = useId();
  const [inputs, setInputs] = useState({}); // remotePort -> string
  const [busy, setBusy] = useState({}); // remotePort -> bool
  const [fieldErrors, setFieldErrors] = useState({}); // remotePort -> string
  const [error, setError] = useState(null);

  const { data, error: loadError, refetch, setData } = useRequest(
    ({ signal }) => getJson(p('api', 'portforward'), { signal }),
    { deps: [namespace, name], enabled: !!namespace && !!name, dedupeKey: 'portforward' },
  );
  const forwards = {};
  (data?.forwards || []).forEach((f) => { if (f.namespace === namespace && f.name === name) forwards[f.remotePort] = f; });

  const setBusyFor = (rp, v) => setBusy((b) => ({ ...b, [rp]: v }));

  const start = async (remotePort) => {
    const raw = inputs[remotePort] || '';
    const invalid = validatePort(raw);
    if (invalid) { setFieldErrors((e) => ({ ...e, [remotePort]: invalid })); return; }
    setFieldErrors((e) => ({ ...e, [remotePort]: null }));
    setBusyFor(remotePort, true);
    setError(null);
    try {
      const localPort = raw ? Number(raw) : undefined;
      const fwd = await postJson(p('api', 'portforward'), { namespace, name, remotePort: Number(remotePort), localPort });
      setData((d) => ({ ...(d || {}), forwards: [...((d && d.forwards) || []).filter((f) => f.id !== fwd.id), fwd] }));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusyFor(remotePort, false);
    }
  };

  const stop = async (remotePort) => {
    const fwd = forwards[remotePort];
    if (!fwd) return;
    setBusyFor(remotePort, true);
    setError(null);
    try {
      await del(p('api', 'portforward', fwd.id));
      setData((d) => ({ ...(d || {}), forwards: ((d && d.forwards) || []).filter((f) => f.id !== fwd.id) }));
    } catch (e) {
      if (e?.status === 404) setData((d) => ({ ...(d || {}), forwards: ((d && d.forwards) || []).filter((f) => f.id !== fwd.id) }));
      else setError(friendlyError(e));
    } finally {
      setBusyFor(remotePort, false);
    }
  };

  if (!ports.length) return null;

  return (
    <section className="drawer-section" aria-label="Port forwarding">
      <div className="drawer-section-title data-title">
        <span>Port Forwarding</span>
        {onClose && <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel="Close port forwarding" onClick={onClose} />}
      </div>
      {loadError && (
        <div className="drawer-error pf-error" role="alert">
          Couldn't load active port-forwards: {errorMessage(loadError)}{' '}
          <button type="button" className="xlink" onClick={refetch}>Retry</button>
        </div>
      )}
      {error && <div className="drawer-error pf-error" role="alert">{error}</div>}
      {ports.map((pt) => {
        const rp = pt.port;
        const fwd = forwards[rp];
        const inputId = `${uid}-lp-${rp}`;
        const errId = `${uid}-err-${rp}`;
        const warnId = `${uid}-warn-${rp}`;
        const fieldError = fieldErrors[rp] || validatePort(inputs[rp] || '');
        const warning = portWarning(inputs[rp] || '');
        const describedBy = [fieldError ? errId : null, warning ? warnId : null].filter(Boolean).join(' ') || undefined;
        return (
          <div key={`${rp}/${pt.protocol || 'TCP'}/${pt.name || ''}`} className="pf-row">
            <div className="pf-port">
              {rp}
              <span className="drawer-dim">/{pt.protocol || 'TCP'}{pt.name ? ` · ${pt.name}` : ''}</span>
            </div>
            {fwd ? (
              <div className="pf-controls">
                <a
                  className="xlink pf-link"
                  href={`http://localhost:${fwd.localPort}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open localhost:${fwd.localPort} in a new tab`}
                >
                  <Icon name="ingress" size={13} /> localhost:{fwd.localPort}
                </a>
                <button type="button" className="pf-btn stop" onClick={() => stop(rp)} disabled={busy[rp]} aria-busy={busy[rp] || undefined} aria-label={`Stop forwarding port ${rp}`}>
                  {busy[rp] ? '…' : 'Stop'}
                </button>
              </div>
            ) : (
              <div className="pf-controls pf-form">
                <div className="pf-field">
                  <label htmlFor={inputId} className="sr-only">Local port for service port {rp} (leave blank for a random port)</label>
                  <input
                    id={inputId}
                    className="pf-input"
                    placeholder="random"
                    inputMode="numeric"
                    autoComplete="off"
                    value={inputs[rp] || ''}
                    onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ''); setInputs((s) => ({ ...s, [rp]: v })); setFieldErrors((er) => ({ ...er, [rp]: null })); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); start(rp); } }}
                    aria-invalid={fieldError ? 'true' : undefined}
                    aria-describedby={describedBy}
                  />
                  {fieldError && <div id={errId} className="pf-msg pf-msg-error" role="alert">{fieldError}</div>}
                  {!fieldError && warning && <div id={warnId} className="pf-msg pf-msg-warn">{warning}</div>}
                </div>
                <button type="button" className="pf-btn" onClick={() => start(rp)} disabled={busy[rp] || !!fieldError} aria-busy={busy[rp] || undefined} aria-label={`Forward port ${rp}`}>
                  {busy[rp] ? '…' : 'Forward'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
