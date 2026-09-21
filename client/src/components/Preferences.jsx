import { useCallback, useEffect, useId, useState } from 'react';
import Icon from './Icons';
import Loader from './Loader';
import Button from './ui/Button';
import useRequest from '../hooks/useRequest';
import { getJson, postJson, del, sseFetch, errorMessage } from '../lib/api';
import { AGENT_ICON } from '../lib/kinds';
import {
  getAiConfig, setAiConfig, getAiExternalTerminal, setAiExternalTerminal,
} from '../aiConfig';

// Full-page Preferences view: a left sub-nav of sections and a content pane.
// The active section comes from the route (`#/preferences/<section>`).

export const SECTIONS = [
  { key: 'general', label: 'General', icon: 'configuration' },
  { key: 'kubernetes', label: 'Kubernetes', icon: 'cluster' },
  { key: 'integrations', label: 'Cloud Integrations', icon: 'hexagon' },
  { key: 'external-tools', label: 'External Tools', icon: 'sparkles' },
  { key: 'assistant', label: 'AI Assistant', icon: 'send' },
  { key: 'mcp', label: 'MCP Server', icon: 'terminal' },
  { key: 'about', label: 'About', icon: 'details' },
];

/** A valid absolute http(s) URL (for the LLM base URL). */
export function isHttpUrl(v) {
  try { const u = new URL(String(v || '').trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

export default function Preferences({ configStatus, theme, onSetTheme, onChangeConfig, onAddAzure, onAddAws, section: routeSection, onSectionChange, onClose }) {
  const section = SECTIONS.some((s) => s.key === routeSection) ? routeSection : 'general';

  // Esc closes the page (when no dialog/menu is open above it).
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.ui-modal-backdrop, .ui-menu')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="prefs-page">
      <nav className="prefs-sidenav" aria-label="Preferences sections">
        <div className="prefs-sidenav-title" id="prefs-title">Preferences</div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`prefs-navitem ${section === s.key ? 'active' : ''}`}
            aria-current={section === s.key ? 'page' : undefined}
            onClick={() => onSectionChange?.(s.key)}
          >
            <Icon name={s.icon} size={15} /> {s.label}
          </button>
        ))}
      </nav>
      <div className="prefs-content">
        {onClose && (
          <Button variant="secondary" size="sm" iconOnly icon="close" iconSize={18} ariaLabel="Close preferences (Esc)" className="prefs-close" onClick={onClose} />
        )}
        {section === 'general' && <GeneralSection theme={theme} onSetTheme={onSetTheme} />}
        {section === 'kubernetes' && <KubernetesSection configStatus={configStatus} onChangeConfig={onChangeConfig} />}
        {section === 'integrations' && <IntegrationsSection onAddAzure={onAddAzure} onAddAws={onAddAws} />}
        {section === 'external-tools' && <ExternalToolsSection />}
        {section === 'assistant' && <AssistantSection />}
        {section === 'mcp' && <McpSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

/* ── General ─────────────────────────────────────────────────────── */
function GeneralSection({ theme, onSetTheme }) {
  const id = useId();
  const opts = [{ k: 'system', label: 'System', icon: 'monitor' }, { k: 'dark', label: 'Dark', icon: 'moon' }, { k: 'light', label: 'Light', icon: 'sun' }];
  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">General</h1>
      <Field label="Theme" hint="Choose how the app looks. System follows your OS appearance." labelId={`${id}-theme`}>
        <div className="prefs-seg" role="radiogroup" aria-labelledby={`${id}-theme`}>
          {opts.map((t) => (
            <button key={t.k} type="button" role="radio" aria-checked={theme === t.k} className={`prefs-seg-btn ${theme === t.k ? 'active' : ''}`} onClick={() => onSetTheme(t.k)}>
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

/* ── Kubernetes ──────────────────────────────────────────────────── */
function KubernetesSection({ configStatus, onChangeConfig }) {
  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">Kubernetes</h1>
      <Field label="Kubeconfig" hint="The file the app reads clusters and contexts from.">
        <div className="prefs-inline">
          <code className="prefs-code">{configStatus?.path || configStatus?.defaultPath || '~/.kube/config'}</code>
          <Button variant="secondary" size="sm" onClick={onChangeConfig}>Change…</Button>
        </div>
      </Field>
      <Field label="Current context" hint="The cluster that new requests target.">
        <code className="prefs-code">{configStatus?.currentContext || '—'}</code>
      </Field>
      <Field label="Available contexts">
        <span className="prefs-muted">{(configStatus?.contexts || []).length} context(s) across {(configStatus?.clusters || []).length} cluster(s)</span>
      </Field>
    </div>
  );
}

/* ── Cloud Integrations ──────────────────────────────────────────── */
function IntegrationsSection({ onAddAzure, onAddAws }) {
  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">Cloud Integrations</h1>
      <p className="prefs-lead">Add clusters straight from your cloud account — no CLI required. We handle login and write the kubeconfig for you.</p>
      <div className="prefs-cards">
        <div className="prefs-int-card">
          <div className="prefs-int-head"><Icon name="azure" size={22} /> <span>Azure AKS</span></div>
          <p className="prefs-muted">Sign in to Azure and import your AKS clusters.</p>
          <Button variant="primary" size="sm" onClick={onAddAzure}>Add Azure clusters</Button>
        </div>
        <div className="prefs-int-card">
          <div className="prefs-int-head"><Icon name="aws" size={22} /> <span>AWS EKS</span></div>
          <p className="prefs-muted">SSO, access keys or IAM role — discover and import EKS clusters.</p>
          <Button variant="primary" size="sm" onClick={onAddAws}>Add AWS clusters</Button>
        </div>
      </div>
    </div>
  );
}

/* ── External Tools (AI agent) ───────────────────────────────────── */
function ExternalToolsSection() {
  const id = useId();
  const [cfg, setCfg] = useState(getAiConfig);
  const [extTerm, setExtTerm] = useState(getAiExternalTerminal);
  const { data, loading, refetch } = useRequest(({ signal }) => getJson('/api/ai-agents', { signal }).then((d) => d.agents || []), { deps: [], dedupeKey: 'ai-agents' });
  const agents = data || [];

  const sel = cfg.mode === 'agent' ? cfg.id : cfg.mode; // agentId | 'builtin' | 'none'
  const detected = agents.filter((a) => a.installed).length;

  const choose = (next) => {
    let c;
    if (next === 'builtin') c = { mode: 'builtin' };
    else if (next === 'none') c = { mode: 'none' };
    else { const a = agents.find((x) => x.id === next); if (!a) return; c = { mode: 'agent', id: a.id, name: a.name }; }
    setCfg(c); setAiConfig(c);
  };

  const toggleExt = () => { const on = !extTerm; setExtTerm(on); setAiExternalTerminal(on); };

  const radio = (key, { icon, name, sub, disabled, status }) => (
    <label key={key} className={`prefs-ai-opt ${disabled ? 'disabled' : ''} ${sel === key ? 'sel' : ''}`}>
      <input type="radio" name={`${id}-aitool`} checked={sel === key} disabled={disabled} onChange={() => choose(key)} />
      <span className="prefs-ai-ico" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <span className="prefs-ai-main">
        <span className="prefs-ai-name">{name}</span>
        {sub && <span className="prefs-ai-sub">{sub}</span>}
      </span>
      {status}
    </label>
  );

  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">External Tools</h1>
      <div className="prefs-ai-label">AI TOOL <span className="prefs-premium">FREE</span></div>
      <p className="prefs-lead">The AI tool the app launches for e.g. <strong>"Ask AI"</strong>. Bring your own agent — it runs in a terminal with your cluster context loaded, no API key.</p>

      <div className="prefs-detect-row">
        <span className="prefs-muted" aria-live="polite">{detected} of {agents.length} detected on your system</span>
        <button type="button" className="prefs-link" onClick={refetch}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      {loading ? <div className="prefs-center"><Loader label="Detecting installed AI tools…" /></div> : (
        <div className="prefs-ai-list" role="radiogroup" aria-label="AI tool">
          {agents.map((a) => radio(a.id, {
            icon: AGENT_ICON[a.id] || 'sparkles',
            name: a.name,
            sub: a.installed ? a.desc : 'Not found in PATH',
            disabled: !a.installed,
            status: a.installed
              ? <span className="prefs-ai-status ok"><Icon name="check" size={12} /> INSTALLED</span>
              : <a className="prefs-ai-status link" href={a.install} target="_blank" rel="noreferrer noopener">HOW TO INSTALL<span className="sr-only"> {a.name}</span></a>,
          }))}
          {radio('builtin', { icon: 'send', name: 'Built-in assistant', sub: "Uses the app's own AI (API-based)" })}
          {radio('none', { icon: 'close', name: 'No AI tool', sub: 'The app does not launch an AI tool' })}
        </div>
      )}

      <div className="prefs-toggle-row">
        <div>
          <div className="prefs-toggle-label" id={`${id}-ext`}>Open AI tools in an external terminal</div>
          <div className="prefs-muted" id={`${id}-ext-hint`}>Launch the selected AI tool in a new terminal window instead of an in-app terminal tab.</div>
        </div>
        <button type="button" className={`prefs-switch ${extTerm ? 'on' : ''}`} onClick={toggleExt} role="switch" aria-checked={extTerm} aria-labelledby={`${id}-ext`} aria-describedby={`${id}-ext-hint`}><span /></button>
      </div>
    </div>
  );
}

/* ── AI Assistant (built-in LLM connection) ──────────────────────── */
function AssistantSection() {
  const id = useId();
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(false);

  const refresh = useCallback(() => getJson('/api/assistant/status').then((d) => {
    setStatus(d);
    if (d.baseUrl) setUrl((v) => v || d.baseUrl);
    if (d.model) setModel((v) => v || d.model);
  }).catch(() => setStatus({ enabled: false })), []);
  useEffect(() => { refresh(); }, [refresh]);

  const urlError = url.trim() && !isHttpUrl(url) ? 'Enter a full http(s) URL, e.g. https://api.openai.com/v1' : null;
  const canSave = isHttpUrl(url) && model.trim() && key.trim() && !saving;

  const save = async (e) => {
    e?.preventDefault?.();
    setTouched(true);
    if (!canSave) return;
    setSaving(true); setErr(null); setSaved(false);
    try {
      await postJson('/api/assistant/config', { baseUrl: url.trim(), model: model.trim(), apiKey: key.trim() });
      setKey(''); setSaved(true); await refresh();
    } catch (e2) { setErr(errorMessage(e2)); } finally { setSaving(false); }
  };
  const forget = async () => { try { await del('/api/assistant/config'); setKey(''); setSaved(false); await refresh(); } catch { /* ignore */ } };

  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">AI Assistant</h1>
      <p className="prefs-lead">The built-in assistant connects to any OpenAI-compatible endpoint (TrueFoundry, OpenAI, Azure, LiteLLM…). Used when "Built-in assistant" is selected under External Tools.</p>

      {status && (
        <div className={`prefs-badge-row ${status.enabled ? 'ok' : ''}`} role="status">
          <Icon name={status.enabled ? 'check' : 'warning'} size={14} />
          {status.enabled ? `Connected · ${status.model || 'model set'}${status.source === 'env' ? ' (from environment)' : ''}` : 'Not configured'}
        </div>
      )}

      {status && status.editable === false ? (
        <p className="prefs-muted">Configured via server environment (<code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code>, <code>LLM_MODEL</code>).</p>
      ) : (
        <form onSubmit={save} noValidate>
          <Field label="API base URL" htmlFor={`${id}-url`} hint="Everything before /chat/completions." hintId={`${id}-url-hint`} error={touched ? urlError : null} errorId={`${id}-url-err`}>
            <input id={`${id}-url`} className="prefs-text" type="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => setTouched(true)} placeholder="https://<org>.truefoundry.cloud/api/llm/api/inference/openai" spellCheck={false} autoComplete="off" required aria-required="true" aria-invalid={touched && urlError ? 'true' : undefined} aria-describedby={touched && urlError ? `${id}-url-err` : `${id}-url-hint`} />
          </Field>
          <Field label="Model" htmlFor={`${id}-model`}>
            <input id={`${id}-model`} className="prefs-text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. openai-main/gpt-4o" spellCheck={false} autoComplete="off" required aria-required="true" />
          </Field>
          <Field label="API key" htmlFor={`${id}-key`}>
            <input id={`${id}-key`} className="prefs-text" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.enabled ? '•••••• (stored)' : 'API token'} spellCheck={false} autoComplete="off" required aria-required="true" />
          </Field>
          {err && <div className="prefs-badge-row err" role="alert"><Icon name="warning" size={13} /> {err}</div>}
          {saved && <div className="prefs-badge-row ok" role="status"><Icon name="check" size={13} /> Saved</div>}
          <div className="prefs-inline prefs-inline-top">
            <Button type="submit" variant="primary" size="sm" busy={saving} disabled={!canSave}>{saving ? 'Validating…' : 'Save connection'}</Button>
            {status?.source === 'stored' && <Button variant="secondary" size="sm" onClick={forget}>Forget saved connection</Button>}
          </div>
        </form>
      )}
    </div>
  );
}

/* ── MCP ─────────────────────────────────────────────────────────── */
// Small copy-to-clipboard button that flips to a check for a moment.
function CopyBtn({ text, label = 'Copy' }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* ignore */ }
  };
  return (
    <Button variant="secondary" size="sm" icon={ok ? 'check' : 'copy'} onClick={copy} aria-label={label} aria-live="polite">
      {ok ? 'Copied' : 'Copy'}
    </Button>
  );
}

// A labelled, copyable code block. `display` is what is shown; `value` what is
// copied (so a masked token can still be copied in full).
function CopyField({ label, hint, value, display, copyLabel }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} labelId={`${id}-l`}>
      <div className="prefs-inline">
        <pre className="prefs-code prefs-code-block" aria-labelledby={`${id}-l`} tabIndex={0}>{display ?? value}</pre>
        <CopyBtn text={value} label={copyLabel || `Copy ${label}`} />
      </div>
    </Field>
  );
}

const MASK = '••••••••••••';

function McpSection() {
  const { data: info, error, refetch, setData } = useRequest(({ signal }) => getJson('/api/mcp/info', { signal }), { deps: [], dedupeKey: 'mcp-info' });
  const [test, setTest] = useState({ state: 'idle' }); // idle | testing | ok | fail
  const [reveal, setReveal] = useState(false);

  const httpUrl = info?.httpUrl || '';
  const token = info?.token || info?.stdioEnv?.MCP_API_TOKEN || '';
  const apiBase = info?.stdioEnv?.MCP_API_BASE || '';
  const shownToken = reveal ? token : MASK;

  const testConnection = async () => {
    if (!httpUrl) return;
    setTest({ state: 'testing' });
    try {
      const res = await sseFetch(httpUrl, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'k8sight-prefs', version: '1.0' } },
      }, { headers: { Accept: 'application/json, text/event-stream' } });
      const sid = res.headers.get('mcp-session-id');
      if (sid) {
        setTest({ state: 'ok' });
        // Politely end the probe session.
        sseFetch(httpUrl, undefined, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => {});
      } else {
        setTest({ state: 'fail', msg: 'No session id returned' });
      }
    } catch (e) {
      setTest({ state: 'fail', msg: errorMessage(e) });
    }
  };

  const setWrite = async (allowWrite) => {
    setData((prev) => ({ ...(prev || {}), allowWrite })); // optimistic
    try {
      const data = await postJson('/api/mcp/config', { allowWrite });
      setData((prev) => ({ ...(prev || {}), allowWrite: data.allowWrite }));
    } catch {
      refetch(); // revert on failure
    }
  };

  const claudeCmd = (t) => `claude mcp add --transport http k8sight ${httpUrl} --header "Authorization: Bearer ${t}"`;
  const stdioJson = (t) => JSON.stringify({
    mcpServers: {
      k8sight: {
        command: 'node',
        args: ['/absolute/path/to/k8sight/mcp-stdio.js'],
        env: { MCP_API_BASE: apiBase, MCP_API_TOKEN: t },
      },
    },
  }, null, 2);
  const httpJson = (t) => JSON.stringify({ mcpServers: { k8sight: { url: httpUrl, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);

  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">MCP Server</h1>
      <p className="prefs-lead">
        k8sight is a <a className="prefs-link" href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">Model Context Protocol</a> server,
        so any MCP-compatible agent (Claude Code, Claude Desktop, Cursor…) can inspect and operate the
        <strong> currently selected cluster</strong>. The server runs while the app is open. Every request needs the session token below.
      </p>

      {error && <div className="prefs-badge-row err" role="alert"><Icon name="warning" size={13} /> {errorMessage(error, 'Could not load MCP info')}</div>}

      {info && (
        <>
          <Field label="Session token" hint="Sent as a Bearer token. Masked by default — reveal or copy it into your client config.">
            <div className="prefs-inline">
              <code className="prefs-code" aria-label={reveal ? `Token ${token}` : 'Token hidden'}>{shownToken}</code>
              <Button variant="secondary" size="sm" icon={reveal ? 'eyeOff' : 'eye'} aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>{reveal ? 'Hide' : 'Reveal'}</Button>
              <CopyBtn text={token} label="Copy token" />
            </div>
          </Field>

          <CopyField label="HTTP endpoint" hint="Streamable HTTP transport — recommended." value={httpUrl} copyLabel="Copy HTTP endpoint" />

          <CopyField label="Add to Claude Code" hint="Run this in your terminal." value={() => claudeCmd(token)} display={claudeCmd(shownToken)} copyLabel="Copy Claude Code command" />

          <CopyField label="MCP client config — HTTP (Cursor / .mcp.json)" hint="For clients that take a JSON config." value={() => httpJson(token)} display={httpJson(shownToken)} copyLabel="Copy HTTP client config" />

          <CopyField label="MCP client config — stdio (Claude Desktop)" hint="Launches the bundled mcp-stdio.js bridge; the app must be running." value={() => stdioJson(token)} display={stdioJson(shownToken)} copyLabel="Copy stdio client config" />

          <Field label="Connection">
            <div className="prefs-inline">
              <Button variant="primary" size="sm" onClick={testConnection} busy={test.state === 'testing'}>
                {test.state === 'testing' ? 'Testing…' : 'Test connection'}
              </Button>
              <span role="status" className="prefs-muted">
                {test.state === 'ok' && <span className="tone-ok"><Icon name="check" size={14} /> Connected</span>}
                {test.state === 'fail' && <span className="tone-bad">Failed: {test.msg}</span>}
              </span>
            </div>
          </Field>

          <Field label="Write access" hint="Read-only is safest. Enabling lets agents apply, delete, scale and sync — mutating your cluster." labelId="mcp-write-label">
            <div className="prefs-stack">
              <div className="prefs-seg" role="radiogroup" aria-labelledby="mcp-write-label">
                <button type="button" role="radio" aria-checked={!info.allowWrite} className={`prefs-seg-btn ${!info.allowWrite ? 'active' : ''}`} onClick={() => setWrite(false)}>Read-only</button>
                <button type="button" role="radio" aria-checked={!!info.allowWrite} className={`prefs-seg-btn ${info.allowWrite ? 'active' : ''}`} onClick={() => setWrite(true)}>Read &amp; write</button>
              </div>
              <div className={`prefs-status ${info.allowWrite ? 'warn' : 'ok'}`} role="status">
                <span className="prefs-status-dot" aria-hidden="true" />
                {info.allowWrite ? 'Write tools exposed — reconnect your agent to pick them up.' : 'Only read tools are exposed.'}
              </div>
            </div>
          </Field>

          <Field label="Available tools">
            <ul className="prefs-mcp-tools">
              {(info.readTools || []).map((t) => <li key={t} className="prefs-chip">{t}</li>)}
              {info.allowWrite && (info.writeTools || []).map((t) => <li key={t} className="prefs-chip write">{t}</li>)}
            </ul>
          </Field>
        </>
      )}
    </div>
  );
}

function AboutSection() {
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
  return (
    <div className="prefs-section">
      <h1 className="prefs-h2">About</h1>
      <Field label="k8sight">{version ? <span className="prefs-muted">Version {version}</span> : null}</Field>
      <p className="prefs-lead">A native Kubernetes management app — cluster overview, resources, topology, ArgoCD, one-click AKS/EKS, terminals and bring-your-own AI agents.</p>
    </div>
  );
}

/* ── shared field wrapper ────────────────────────────────────────── */
/**
 * Renders a real `<label>` (`htmlFor` when the control has an id, otherwise an
 * id you can point `aria-labelledby` at via `labelId`). Hints/errors get ids
 * for `aria-describedby` (`hintId` / `errorId`).
 */
export function Field({ label, hint, htmlFor, labelId, hintId, error, errorId, children }) {
  return (
    <div className="prefs-field">
      <label className="prefs-field-label" htmlFor={htmlFor} id={labelId}>{label}</label>
      {hint && <div className="prefs-field-hint" id={hintId}>{hint}</div>}
      <div className="prefs-field-control">{children}</div>
      {error && <div className="prefs-field-error" id={errorId} role="alert"><Icon name="warning" size={12} /> {error}</div>}
    </div>
  );
}
