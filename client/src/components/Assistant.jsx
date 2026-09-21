import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import Markdown from './Markdown';
import Button from './ui/Button';
import { isExternalAgent } from '../aiConfig';
import { getJson, postJson, del, sseFetch, errorMessage, isAbortError } from '../lib/api';
import { isHttpUrl } from './Preferences';

// Docked AI assistant. Streams a read-only, tool-using debugging session from
// /api/assistant/chat (SSE) and renders tokens + tool-call chips live.

const SUGGESTIONS = [
  'Why is this pod not ready?',
  'Any warning events in this namespace?',
  'Summarize the health of my workloads',
];

let msgSeq = 0;
const newId = () => `m${Date.now().toString(36)}-${++msgSeq}`;

export default function Assistant({ context }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [enabled, setEnabled] = useState(null); // null = unknown, false = no key
  const [model, setModel] = useState('');
  const [source, setSource] = useState(null); // 'env' | 'stored' | null
  const [editable, setEditable] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]); // { id, role, text, tools:[], error? }
  // LLM connection form
  const [urlInput, setUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [urlTouched, setUrlTouched] = useState(false);
  const [liveMsg, setLiveMsg] = useState('');
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const contextRef = useRef(context); contextRef.current = context;
  // Streaming buffer: tokens accumulate here and are committed to state once
  // per animation frame, so the message array is not copied per token.
  const streamRef = useRef({ id: null, text: '', tools: [], error: null, raf: 0 });

  const refreshStatus = useCallback(() => getJson('/api/assistant/status')
    .then((d) => {
      setEnabled(d.enabled); setModel(d.model || ''); setSource(d.source || null); setEditable(d.editable !== false);
      // Prefill the form so editing an existing connection is easy.
      if (d.baseUrl) setUrlInput((v) => v || d.baseUrl);
      if (d.model) setModelInput((v) => v || d.model);
      return d;
    })
    .catch(() => { setEnabled(false); }), []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const urlError = urlInput.trim() && !isHttpUrl(urlInput) ? 'Enter a full http(s) URL.' : null;

  const saveConfig = async () => {
    const baseUrl = urlInput.trim();
    const m = modelInput.trim();
    const apiKey = keyInput.trim();
    setUrlTouched(true);
    if (!isHttpUrl(baseUrl) || !m || !apiKey || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await postJson('/api/assistant/config', { baseUrl, model: m, apiKey });
      setKeyInput('');
      await refreshStatus();
    } catch (err) {
      setKeyError(errorMessage(err, 'Could not save the connection'));
    } finally {
      setSavingKey(false);
    }
  };

  const forget = async () => {
    try {
      await del('/api/assistant/config');
      setMessages([]);
      setKeyInput('');
      await refreshStatus();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  // Commit the streaming buffer into the last message (O(1) per frame: only
  // the last element is replaced).
  const flush = useCallback(() => {
    const s = streamRef.current;
    s.raf = 0;
    if (!s.id) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.id !== s.id) return prev;
      const next = prev.slice(0, -1);
      next.push({ ...last, text: s.text, tools: s.tools, error: s.error });
      return next;
    });
  }, []);
  const scheduleFlush = useCallback(() => {
    const s = streamRef.current;
    if (!s.raf) s.raf = requestAnimationFrame(flush);
  }, [flush]);

  const send = useCallback(async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');

    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    history.push({ role: 'user', text: q });
    const assistantId = newId();
    setMessages((prev) => [...prev, { id: newId(), role: 'user', text: q }, { id: assistantId, role: 'assistant', text: '', tools: [] }]);
    setBusy(true);
    streamRef.current = { id: assistantId, text: '', tools: [], error: null, raf: 0 };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await sseFetch('/api/assistant/chat', { messages: history, context: contextRef.current }, { signal: controller.signal });
      if (!resp.body) throw new Error('Empty response');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() || '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const s = streamRef.current;
          if (evt.type === 'token') s.text += evt.text;
          else if (evt.type === 'tool') s.tools = [...s.tools, { name: evt.name, input: evt.input }];
          else if (evt.type === 'error') s.error = evt.message;
          scheduleFlush();
        }
      }
    } catch (err) {
      if (!isAbortError(err)) { streamRef.current.error = errorMessage(err, 'Request failed'); scheduleFlush(); }
    } finally {
      cancelAnimationFrame(streamRef.current.raf);
      streamRef.current.raf = 0;
      flush();
      streamRef.current.id = null;
      setBusy(false);
      abortRef.current = null;
      setLiveMsg('');
      setTimeout(() => setLiveMsg('Assistant replied'), 30);
    }
  }, [input, busy, messages, flush, scheduleFlush]);

  const stop = () => { abortRef.current?.abort(); };

  // Other views (e.g. the ArgoCD "Summarize" action) can ask the assistant a
  // question by dispatching a window `assistant:ask` event with { prompt }.
  // Listeners are registered once; they read the latest handlers via refs.
  const sendRef = useRef(send); sendRef.current = send;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  useEffect(() => {
    const onAsk = (e) => {
      const prompt = e.detail?.prompt;
      if (!prompt) return;
      if (isExternalAgent()) return; // an external CLI agent handles it instead
      setOpen(true);
      setMinimized(false);
      if (enabledRef.current) sendRef.current(prompt);
      else setInput(prompt);
    };
    // The AI-tool button opens the chat window directly (no prompt) when the
    // built-in assistant is the chosen tool.
    const onOpen = () => { setOpen(true); setMinimized(false); };
    window.addEventListener('assistant:ask', onAsk);
    window.addEventListener('assistant:open', onOpen);
    return () => { window.removeEventListener('assistant:ask', onAsk); window.removeEventListener('assistant:open', onOpen); };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const toolLabel = (t) => {
    const i = t.input || {};
    const detail = i.pod ? `${i.namespace}/${i.pod}` : i.name ? `${i.namespace ? `${i.namespace}/` : ''}${i.name}` : i.kind ? `${i.kind} in ${i.namespace}` : i.namespace || '';
    return `${t.name}${detail ? ` · ${detail}` : ''}`;
  };

  if (!open) return null;

  const titleId = `${id}-title`;
  return (
    <section className={`assistant-panel ${minimized ? 'minimized' : ''}`} role="complementary" aria-label="AI assistant" aria-labelledby={titleId}>
      <div className="assistant-header">
        <span className="assistant-title" id={titleId}><Icon name="sparkles" size={16} /> AI Assistant</span>
        {model && <span className="assistant-model">{model}</span>}
        <Button
          variant="ghost" size="sm" iconOnly
          icon={minimized ? 'chevronUp' : 'minus'}
          className="assistant-x"
          ariaLabel={minimized ? 'Expand assistant' : 'Minimize assistant'}
          aria-expanded={!minimized}
          onClick={() => setMinimized((m) => !m)}
        />
        <Button variant="ghost" size="sm" iconOnly icon="close" className="assistant-x" ariaLabel="Close assistant" onClick={() => { stop(); setOpen(false); }} />
      </div>

      <div className="assistant-body" ref={scrollRef}>
        {enabled === false && editable && (
          <div className="assistant-empty">
            <p><strong>Connect an LLM API</strong> to enable the assistant. Any OpenAI-compatible endpoint works (TrueFoundry, OpenAI, Azure, LiteLLM, …). Stored on this machine for next time.</p>
            <form className="assistant-key-form" onSubmit={(e) => { e.preventDefault(); saveConfig(); }} noValidate>
              <label className="assistant-field-label" htmlFor={`${id}-url`}>API base URL</label>
              <input id={`${id}-url`} type="url" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onBlur={() => setUrlTouched(true)} placeholder="https://<org>.truefoundry.cloud/api/llm/api/inference/openai" autoComplete="off" spellCheck={false} required aria-required="true" aria-invalid={urlTouched && urlError ? 'true' : undefined} aria-describedby={urlTouched && urlError ? `${id}-url-err` : `${id}-hint`} />
              {urlTouched && urlError && <div id={`${id}-url-err`} className="assistant-error" role="alert"><Icon name="warning" size={13} /> {urlError}</div>}
              <label className="assistant-field-label" htmlFor={`${id}-model`}>Model</label>
              <input id={`${id}-model`} type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)} placeholder="e.g. openai-main/gpt-4o" autoComplete="off" spellCheck={false} required aria-required="true" />
              <label className="assistant-field-label" htmlFor={`${id}-key`}>API key</label>
              <input id={`${id}-key`} type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="API token" autoComplete="off" spellCheck={false} required aria-required="true" />
              <Button type="submit" variant="primary" size="sm" busy={savingKey} disabled={!isHttpUrl(urlInput) || !modelInput.trim() || !keyInput.trim()}>
                {savingKey ? 'Validating…' : 'Connect'}
              </Button>
            </form>
            {keyError && <div className="assistant-error" role="alert"><Icon name="warning" size={13} /> {keyError}</div>}
            <p className="assistant-hint" id={`${id}-hint`}>The base URL is everything before <code>/chat/completions</code>. Stored in <code>~/.config/k8s-manager/config.json</code>.</p>
          </div>
        )}

        {enabled === false && !editable && (
          <div className="assistant-empty">
            <p><strong>AI assistant isn't configured.</strong></p>
            <p>Set <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code>, and <code>LLM_MODEL</code> in the server environment and restart.</p>
          </div>
        )}

        {enabled && messages.length === 0 && (
          <div className="assistant-empty">
            <p>Ask about your cluster — I can read logs, events, and resource specs to help debug. I can't make changes.</p>
            <div className="assistant-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} disabled={busy}>{s}</button>
              ))}
            </div>
            {source === 'stored' && (
              <button type="button" className="assistant-forget" onClick={forget}>Forget saved LLM connection</button>
            )}
          </div>
        )}

        <div className="assistant-log" role="log" aria-label="Conversation">
          {messages.map((m, i) => (
            <div key={m.id} className={`assistant-msg ${m.role}`}>
              {m.role === 'assistant' && (
                <span className="assistant-avatar" aria-hidden="true"><Icon name="sparkles" size={13} /></span>
              )}
              <div className="assistant-msg-content">
                <span className="sr-only">{m.role === 'assistant' ? 'Assistant: ' : 'You: '}</span>
                {(m.tools || []).length > 0 && (
                  <div className="assistant-tools">
                    {m.tools.map((t, j) => (
                      <span key={`${t.name}-${j}`} className="assistant-tool-chip"><Icon name="search" size={11} /> {toolLabel(t)}</span>
                    ))}
                  </div>
                )}
                {m.text && (
                  <div className="assistant-text">
                    {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
                  </div>
                )}
                {m.role === 'assistant' && !m.text && !m.error && busy && i === messages.length - 1 && (
                  <div className="assistant-thinking" role="status" aria-label="Assistant is thinking"><span /><span /><span /></div>
                )}
                {m.error && <div className="assistant-error" role="alert"><Icon name="warning" size={13} /> {m.error}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label htmlFor={`${id}-ask`} className="sr-only">Ask the assistant</label>
        <input
          id={`${id}-ask`}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={enabled === false ? 'Add an API key above to enable' : 'Ask about your cluster…'}
          disabled={enabled === false || busy}
          autoComplete="off"
          data-autofocus
        />
        {busy ? (
          <Button type="button" variant="ghost" size="sm" iconOnly icon="close" className="assistant-send stop" ariaLabel="Stop generating" onClick={stop} />
        ) : (
          <Button type="submit" variant="ghost" size="sm" iconOnly icon="send" className="assistant-send" ariaLabel="Send" disabled={!input.trim() || enabled === false} />
        )}
      </form>
      <div className="sr-only" aria-live="polite">{liveMsg}</div>
    </section>
  );
}
