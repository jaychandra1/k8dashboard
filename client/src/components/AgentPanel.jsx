import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Icon from './Icons';
import Button from './ui/Button';
import { postJson, wsUrl, errorMessage } from '../lib/api';
import { xtermTheme, onThemeChange } from '../lib/tokens';
import { getAiConfig, isExternalAgent, getAiExternalTerminal } from '../aiConfig';

const MIN_H = 160;
const MAX_H = 900;
const STEP = 24;
const clampH = (v) => Math.min(MAX_H, Math.max(MIN_H, v));

// A global terminal panel that runs the configured CLI AI agent with the app's
// cluster context loaded. Opens on a window `agent:open` event { agentId,
// agentName, prompt } (dispatched by the "Ask <agent>" actions). Only known
// agent ids (GET /api/ai-agents) can be launched.
export default function AgentPanel({ context, onOpenChange }) {
  const id = useId();
  const [session, setSession] = useState(null); // { agentId, agentName, prompt, key }
  const [status, setStatus] = useState('connecting');
  const [height, setHeight] = useState(() => { const v = parseInt(localStorage.getItem('agentPanelHeight'), 10); return v >= MIN_H && v <= MAX_H ? v : 340; });
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const dragCleanup = useRef(null);

  // Tell the app when the docked terminal is open.
  useEffect(() => { onOpenChange?.(!!session); }, [session, onOpenChange]);

  const persistHeight = (h) => { try { localStorage.setItem('agentPanelHeight', String(Math.round(h))); } catch { /* ignore */ } };

  // Refit the terminal whenever the docked height changes.
  useEffect(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } }, [height]);

  // Drag the top edge to resize the docked terminal (listeners removed on up / unmount).
  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let lastH = startH;
    const onMove = (ev) => { lastH = clampH(startH + (startY - ev.clientY)); setHeight(lastH); };
    const onUp = () => { dragCleanup.current?.(); persistHeight(lastH); };
    dragCleanup.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      dragCleanup.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
  };
  useEffect(() => () => dragCleanup.current?.(), []);

  const onResizeKey = (e) => {
    let next = null;
    if (e.key === 'ArrowUp') next = height + STEP;
    else if (e.key === 'ArrowDown') next = height - STEP;
    else if (e.key === 'Home') next = MAX_H;
    else if (e.key === 'End') next = MIN_H;
    if (next == null) return;
    e.preventDefault();
    const h = clampH(next);
    setHeight(h);
    persistHeight(h);
  };

  useEffect(() => {
    // If the "external terminal" preference is on, launch in a native OS terminal
    // window instead of the in-app panel.
    const launchExternal = (s) => {
      postJson('/api/ai-agents/launch-external', { agentId: s.agentId, prompt: s.prompt })
        .catch((err) => { window.dispatchEvent(new CustomEvent('toast', { detail: { type: 'error', message: errorMessage(err, 'Could not open external terminal') } })); });
    };
    // Direct open (Configure AI → open terminal) and routed "Ask AI" actions.
    const onOpen = (e) => {
      const s = { agentId: e.detail?.agentId, agentName: e.detail?.agentName, prompt: e.detail?.prompt };
      if (!s.agentId) return;
      if (getAiExternalTerminal()) return launchExternal(s);
      return setSession({ ...s, key: Date.now() });
    };
    const onAsk = (e) => {
      const cfg = getAiConfig();
      if (!isExternalAgent(cfg)) return undefined; // built-in assistant handles it
      const s = { agentId: cfg.id, agentName: cfg.name, prompt: e.detail?.prompt };
      if (getAiExternalTerminal()) return launchExternal(s);
      return setSession({ ...s, key: Date.now() });
    };
    window.addEventListener('agent:open', onOpen);
    window.addEventListener('assistant:ask', onAsk);
    return () => { window.removeEventListener('agent:open', onOpen); window.removeEventListener('assistant:ask', onAsk); };
  }, []);

  const connect = useCallback((term, fit, s) => {
    setStatus('connecting');
    const ws = new WebSocket(wsUrl('/ws/exec', { agent: s.agentId, prompt: s.prompt || undefined }));
    wsRef.current = ws;
    ws.onopen = () => { setStatus('connected'); try { fit.fit(); } catch { /* ignore */ } ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); term.focus(); };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = () => { setStatus('closed'); term.write('\r\n\x1b[90m[agent session ended]\x1b[0m\r\n'); };
    ws.onerror = () => setStatus('closed');
  }, []);

  const sessionKey = session?.key;
  const sessionRef = useRef(session); sessionRef.current = session;
  useEffect(() => {
    const s = sessionRef.current;
    if (!sessionKey || !s || !containerRef.current) return undefined;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: xtermTheme(),
      scrollback: 8000,
      allowProposedApi: true,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term; fitRef.current = fit;

    term.onData((data) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data })); });
    const ro = new ResizeObserver(() => { try { fit.fit(); const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* ignore */ } });
    ro.observe(containerRef.current);
    const unTheme = onThemeChange(() => { try { term.options.theme = xtermTheme(); term.refresh(0, term.rows - 1); } catch { /* ignore */ } });

    connect(term, fit, s);

    return () => {
      try { ro.disconnect(); } catch { /* ignore */ }
      unTheme();
      try { wsRef.current?.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null; fitRef.current = null;
    };
  }, [sessionKey, connect]);

  const reconnect = () => {
    try { wsRef.current?.close(); } catch { /* ignore */ }
    termRef.current?.clear();
    if (termRef.current && fitRef.current && session) connect(termRef.current, fitRef.current, session);
  };
  const close = () => { try { wsRef.current?.close(); } catch { /* ignore */ } setSession(null); };

  if (!session) return null;

  const titleId = `${id}-title`;
  return (
    <section className="agent-panel" style={{ height }} aria-labelledby={titleId}>
      <div
        className="agent-panel-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize agent panel"
        aria-valuenow={height}
        aria-valuemin={MIN_H}
        aria-valuemax={MAX_H}
        aria-controls={`${id}-term`}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={onResizeKey}
        title="Drag or use arrow keys to resize"
      />
      <div className="agent-panel-head">
        <span className="agent-panel-title" id={titleId}><Icon name="sparkles" size={14} /> {session.agentName || 'AI agent'}</span>
        <span className={`agent-panel-status ${status}`} role="status">{status === 'connected' ? `cluster: ${context?.currentContext || 'loaded'}` : status === 'connecting' ? 'starting…' : 'ended'}</span>
        <div className="agent-panel-actions">
          {status === 'closed' && <Button variant="ghost" size="sm" iconOnly icon="refresh" className="agent-panel-btn" ariaLabel="Reconnect" onClick={reconnect} />}
          <Button variant="ghost" size="sm" iconOnly icon="close" className="agent-panel-btn" ariaLabel="Close agent panel" onClick={close} />
        </div>
      </div>
      <div className="agent-panel-term" id={`${id}-term`} ref={containerRef} role="application" aria-label={`${session.agentName || 'AI agent'} terminal`} />
    </section>
  );
}
