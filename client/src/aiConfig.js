// Which AI backend the "Ask AI" / "Summarize" actions use.
//   { mode: 'builtin' }               → the built-in assistant (API)
//   { mode: 'agent', id, name }       → an installed CLI agent (id from GET /api/ai-agents)
//   { mode: 'none' }                  → AI actions disabled
//
// The former `custom` mode (free-form command) is gone: the server only
// launches known agent ids. A stored `custom` config migrates to `builtin`.
import { AGENT_ICON } from './lib/kinds';

const KEY = 'aiAgentConfig';
const DEFAULT = { mode: 'builtin' };

function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return DEFAULT;
  if (cfg.mode === 'agent' && cfg.id) return { mode: 'agent', id: cfg.id, name: cfg.name || cfg.id };
  if (cfg.mode === 'none') return { mode: 'none' };
  return DEFAULT; // 'builtin', legacy 'custom', or anything unknown
}

export function getAiConfig() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY)); } catch { raw = null; }
  const cfg = normalize(raw);
  // One-time migration of a stored `custom` (or malformed) config.
  if (raw && raw.mode !== cfg.mode) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }
  return cfg;
}
export function setAiConfig(cfg) {
  const next = normalize(cfg);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('aiconfig:change', { detail: next }));
}
export function isExternalAgent(cfg = getAiConfig()) { return cfg.mode === 'agent'; }
// Whether to launch agents in a native OS terminal window instead of the in-app panel.
export function getAiExternalTerminal() {
  try { return localStorage.getItem('aiExternalTerminal') === '1'; } catch { return false; }
}
export function setAiExternalTerminal(on) {
  try { localStorage.setItem('aiExternalTerminal', on ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('aiconfig:change'));
}
// Label for the "Ask …" actions, e.g. "Ask Claude Code" / "Ask AI".
export function askLabel(cfg = getAiConfig()) {
  if (cfg.mode === 'agent') return `Ask ${cfg.name || 'agent'}`;
  return 'Ask AI';
}
// Icon name (see Icons.jsx) for the currently-chosen AI tool.
export function aiToolIcon(cfg = getAiConfig()) {
  if (cfg.mode === 'agent') return AGENT_ICON[cfg.id] || 'sparkles';
  if (cfg.mode === 'none') return 'close';
  return 'sparkles'; // builtin
}
// Short label naming the chosen tool, e.g. "Claude Code" / "Built-in assistant".
export function aiToolName(cfg = getAiConfig()) {
  if (cfg.mode === 'agent') return cfg.name || 'Agent';
  if (cfg.mode === 'none') return 'No AI tool';
  return 'Built-in assistant';
}
