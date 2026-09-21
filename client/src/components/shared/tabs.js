/**
 * Roving-tabindex arrow-key handler for a role="tablist" strip whose tabs are
 * sibling buttons carrying `data-key`. Left/Right wrap, Home/End jump; the
 * newly selected tab receives focus.
 */
export function tablistKeys(e, keys, current, select) {
  const i = keys.indexOf(current);
  let next = null;
  if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
  else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
  else if (e.key === 'Home') next = keys[0];
  else if (e.key === 'End') next = keys[keys.length - 1];
  if (next == null) return;
  e.preventDefault();
  select(next);
  const el = e.currentTarget.parentElement?.querySelector(`[role="tab"][data-key="${next}"]`);
  el?.focus();
}
