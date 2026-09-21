import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Icon from './Icons';
import { StatusDot } from './ui/Badge';
import { wsUrl } from '../lib/api';
import { xtermTheme, onThemeChange } from '../lib/tokens';

const STATUS_TONE = { connected: 'ok', connecting: 'warn', closed: 'bad' };

/**
 * Interactive exec terminal for a pod container.
 * <TerminalViewer namespace pod container onClose onStatus />
 */
export default function TerminalViewer({ namespace, pod, container, onClose, onStatus, resource }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | connected | closed
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus;

  const ns = namespace || resource?.namespace;
  const podName = pod || resource?.name;
  const cont = container || resource?.container;

  const updateStatus = useCallback((s) => { setStatus(s); onStatusRef.current?.(s); }, []);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term || !podName) return;
    updateStatus('connecting');

    const ws = new WebSocket(wsUrl('/ws/exec', { namespace: ns, pod: podName, container: cont || undefined }));
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      updateStatus('connected');
      try { fitRef.current?.fit(); } catch { /* not laid out yet */ }
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (e) => { term.write(e.data); };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      updateStatus('closed');
      term.write('\r\n\x1b[90m[session closed — press Reconnect]\x1b[0m\r\n');
    };
    ws.onerror = () => { if (wsRef.current === ws) updateStatus('closed'); };
  }, [ns, podName, cont, updateStatus]);

  const reconnect = () => {
    const prev = wsRef.current;
    wsRef.current = null;
    try { prev?.close(); } catch { /* ignore */ }
    termRef.current?.clear();
    connect();
  };

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return undefined;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: xtermTheme(),
      scrollback: 5000,
      allowProposedApi: true,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* not laid out yet */ }
    termRef.current = term;
    fitRef.current = fit;

    // keystrokes → server
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    });

    // container resize → refit + notify server
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch { /* ignore */ }
    });
    ro.observe(host);

    // re-theme xterm when the app theme toggles
    const unTheme = onThemeChange(() => {
      try { term.options.theme = xtermTheme(); term.refresh(0, term.rows - 1); } catch { /* ignore */ }
    });

    connect();

    return () => {
      try { ro.disconnect(); } catch { /* ignore */ }
      unTheme();
      dataSub.dispose();
      const ws = wsRef.current;
      wsRef.current = null;
      try { ws?.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connect]);

  const statusText = status === 'connected' ? `pod/${podName}` : status === 'connecting' ? 'connecting…' : 'disconnected';
  const statusLabel = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected';

  return (
    <div className="terminal-viewer">
      <div className="terminal-toolbar">
        <span className="terminal-status" role="status" aria-live="polite">
          <StatusDot tone={STATUS_TONE[status] || 'muted'} label={statusLabel} />
          {statusText}
        </span>
        <div className="terminal-toolbar-actions">
          <button type="button" className="terminal-btn" onClick={reconnect} aria-label={`Reconnect terminal to ${podName}`}>
            <Icon name="refresh" size={14} /> Reconnect
          </button>
          <button type="button" className="terminal-btn" onClick={() => termRef.current?.clear()} aria-label="Clear terminal output">
            <Icon name="close" size={14} /> Clear
          </button>
          {onClose && (
            <button type="button" className="terminal-btn" onClick={onClose} aria-label={`Close terminal for ${podName}`}>
              <Icon name="close" size={14} /> Close
            </button>
          )}
        </div>
      </div>
      <div className="xterm-host" ref={containerRef} role="region" aria-label={`Terminal for ${podName}`} />
    </div>
  );
}
