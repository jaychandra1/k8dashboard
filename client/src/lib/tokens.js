// Read design tokens from CSS so SVG (donuts, topology) and xterm can use the
// same colours as the stylesheet in both themes. Never hardcode a hex in a view.

const FALLBACK = {
  dark: {
    '--bg-base': '#000000', '--bg-surface': '#0c0c0e', '--bg-surface-2': '#141416', '--bg-elevated': '#1a1a1d',
    '--border': '#26262b', '--border-strong': '#34343a', '--text': '#ededed', '--text-secondary': '#a1a1a8',
    '--text-muted': '#8b8b95', '--accent': '#e6e6ea', '--accent-strong': '#45454d', '--link': '#58a6ff',
    '--green': '#3fb950', '--yellow': '#d29922', '--red': '#f85149', '--purple': '#bc8cff', '--cyan': '#39c5cf',
    '--term-bg': '#0a0a0a',
  },
  light: {
    '--bg-base': '#ffffff', '--bg-surface': '#f6f8fa', '--bg-surface-2': '#eceff2', '--bg-elevated': '#ffffff',
    '--border': '#d0d7de', '--border-strong': '#c2cbd4', '--text': '#1f2328', '--text-secondary': '#57606a',
    '--text-muted': '#656d76', '--accent': '#0969da', '--accent-strong': '#0969da', '--link': '#0969da',
    '--green': '#1a7f37', '--yellow': '#9a6700', '--red': '#cf222e', '--purple': '#8250df', '--cyan': '#1b7c83',
    '--term-bg': '#ffffff',
  },
};

/** Effective theme: 'light' | 'dark' (resolves data-theme, then the OS preference). */
export function currentTheme() {
  if (typeof document === 'undefined') return 'dark';
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  try { return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; }
}

/** Resolved value of a CSS custom property on :root ('--green' → '#3fb950'). */
export function cssVar(name, fallback) {
  const key = name.startsWith('--') ? name : `--${name}`;
  if (typeof document !== 'undefined') {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
      if (v) return v;
    } catch { /* jsdom / SSR */ }
  }
  return fallback ?? FALLBACK[currentTheme()][key] ?? '';
}

const TONE_VAR = { ok: '--green', warn: '--yellow', bad: '--red', muted: '--text-muted', info: '--link', purple: '--purple', cyan: '--cyan', accent: '--accent' };

/** Resolved colour for a tone, for SVG strokes and canvas — 'ok' → '#3fb950'. */
export function toneColor(tone) {
  return cssVar(TONE_VAR[tone] || TONE_VAR.muted);
}

/** Tinted (alpha) version of a tone colour for backgrounds: 'ok' → 'rgba(63,185,80,0.16)'. */
export function toneTint(tone, alpha = 0.16) {
  const hex = toneColor(tone);
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Track colour for empty donut arcs. */
export function trackColor() {
  return cssVar('--bg-surface-2');
}

/**
 * xterm.js ITheme derived from the current tokens — used by both the pod exec
 * terminal and the docked agent panel. Re-call when data-theme changes.
 */
export function xtermTheme() {
  const light = currentTheme() === 'light';
  const bg = cssVar('--term-bg');
  return {
    background: bg,
    foreground: light ? cssVar('--text') : '#cdd6e4',
    cursor: light ? cssVar('--accent') : cssVar('--green'),
    cursorAccent: bg,
    selectionBackground: light ? 'rgba(9,105,218,0.20)' : 'rgba(180,180,190,0.3)',
    black: light ? '#24292f' : '#0a0a0a',
    red: cssVar('--red'),
    green: cssVar('--green'),
    yellow: cssVar('--yellow'),
    blue: cssVar('--link'),
    magenta: cssVar('--purple'),
    cyan: cssVar('--cyan'),
    white: light ? '#6e7781' : '#cdd6e4',
    brightBlack: light ? '#57606a' : '#6e7681',
    brightRed: light ? '#a40e26' : '#ff7b72',
    brightGreen: light ? '#116329' : '#56d364',
    brightYellow: light ? '#7d4e00' : '#e3b341',
    brightBlue: light ? '#0550ae' : '#79c0ff',
    brightMagenta: light ? '#6639ba' : '#d2a8ff',
    brightCyan: light ? '#1b7c83' : '#56d4dd',
    brightWhite: light ? '#1f2328' : '#ffffff',
  };
}

/**
 * Subscribe to theme changes (data-theme attribute flips). Returns an unsubscribe.
 * Views with xterm call `term.options.theme = xtermTheme()` in the callback.
 */
export function onThemeChange(cb) {
  if (typeof MutationObserver === 'undefined') return () => {};
  const obs = new MutationObserver(() => cb(currentTheme()));
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => obs.disconnect();
}
