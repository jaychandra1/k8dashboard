/**
 * Stable React keys for lists whose items have no id: derive a key from the
 * item's content and de-duplicate repeats with a counter suffix, so an index
 * is never the only thing identifying a row.
 *
 *   withKeys(events, (e) => `${e.reason}|${e.lastTimestamp}`) → [{ key, item }]
 */
export function withKeys(list, keyOf) {
  const seen = new Map();
  return (list || []).map((item) => {
    const base = String(keyOf(item));
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, item };
  });
}
