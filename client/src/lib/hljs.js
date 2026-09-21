// Trimmed highlight.js: only YAML + JSON are registered (the full build is
// ~1 MB). Token colours live in App.css (.hljs-*) so they follow the theme.
import hljs from 'highlight.js/lib/core';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('json', json);

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Highlight `code` as `lang` ('yaml' | 'json'). Always returns safe HTML: on
 * any failure the raw text is escaped instead.
 */
export function highlight(code, lang = 'yaml') {
  const src = String(code ?? '');
  try {
    if (!hljs.getLanguage(lang)) return escapeHtml(src);
    return hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(src);
  }
}

export default hljs;
