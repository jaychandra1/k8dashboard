// Runs before React renders (imported first in main.jsx and also loaded as
// its own <script type="module"> in index.html) so the first paint already
// has the right data-theme — no light/dark flash. CSP is 'self'-only, so
// this can't be an inline script.
(function initTheme() {
  try {
    var t = localStorage.getItem('theme');
    var eff = t;
    if (!t || t === 'system') {
      eff = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', eff);
  } catch (e) { /* storage blocked — CSS default (dark) applies */ }
}());
