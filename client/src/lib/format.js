// Formatting helpers shared by every view. Pure functions — no React, no DOM.

const toMs = (v) => {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  if (!Number.isNaN(t)) return t;
  const helm = parseHelmDate(v);
  return helm ? helm.getTime() : NaN;
};

/**
 * Compact Kubernetes-style age: "12s", "5m", "3h", "2d", "3w", "4mo", "1y".
 * Accepts ISO strings, Date objects, epoch ms, or Helm's timestamp format.
 * Returns "-" for missing/invalid/future input.
 */
export function formatAge(isoOrDate, now = Date.now()) {
  const t = toMs(isoOrDate);
  if (Number.isNaN(t)) return '-';
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return '-';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** Age from a duration in seconds (the Events API gives seconds, not timestamps). */
export function formatAgeSeconds(seconds, now = Date.now()) {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return '-';
  return formatAge(now - seconds * 1000, now);
}

/** Long form: "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatAgeLong(isoOrDate, now = Date.now()) {
  const t = toMs(isoOrDate);
  if (Number.isNaN(t)) return '-';
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return '-';
  if (s < 10) return 'just now';
  const units = [
    [31536000, 'year'], [2592000, 'month'], [604800, 'week'],
    [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second'],
  ];
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${pluralize(n, name)} ago`;
    }
  }
  return 'just now';
}

/**
 * Parse Helm's release timestamp ("2024-01-02 15:04:05.123456789 +0000 UTC",
 * also "... +0530 IST" and the plain " UTC" suffix). Returns a Date or null.
 */
export function parseHelmDate(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*([+-]\d{4})?(?:\s+[A-Z]+)?$/);
  if (!m) return null;
  const [, date, time, frac, tz] = m;
  const ms = frac ? frac.slice(0, 3).padEnd(3, '0') : '000';
  const zone = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const d = new Date(`${date}T${time}.${ms}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Millicores → "250m" (< 1 core) or "1.50" (cores). */
export function fmtCpu(millicores) {
  if (millicores == null || Number.isNaN(Number(millicores))) return '—';
  const m = Number(millicores);
  return m >= 1000 ? `${(m / 1000).toFixed(2)}` : `${Math.round(m)}m`;
}

/** Bytes → "35Mi" / "1.2Gi" / "512Ki" / "12B". */
export function fmtMem(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—';
  const b = Number(bytes);
  const gi = b / 1024 ** 3;
  if (gi >= 1) return `${gi.toFixed(gi >= 10 ? 0 : 1)}Gi`;
  const mi = b / 1024 ** 2;
  if (mi >= 1) return `${Math.round(mi)}Mi`;
  const ki = b / 1024;
  if (ki >= 1) return `${Math.round(ki)}Ki`;
  return `${Math.round(b)}B`;
}

/** Mebibytes → "512 Mi" / "1.50 Gi" (drawer metric charts). */
export function fmtMemMi(mi) {
  if (mi == null || Number.isNaN(Number(mi))) return '—';
  return mi >= 1024 ? `${(mi / 1024).toFixed(2)} Gi` : `${Math.round(mi)} Mi`;
}

const BIN = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
const DEC = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/**
 * Parse a Kubernetes quantity ("500m", "2", "128Mi", "1.5Gi", "1e3", "100n")
 * into a plain number in base units (cores for CPU, bytes for memory).
 * Returns NaN for unparseable input.
 */
export function parseQuantity(q) {
  if (q == null) return NaN;
  if (typeof q === 'number') return q;
  const s = String(q).trim();
  const m = s.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = m[2] || '';
  if (unit in BIN) return n * BIN[unit];
  return n * DEC[unit];
}

/** CPU quantity → millicores ("500m" → 500, "2" → 2000). */
export function cpuToMillicores(q) {
  const cores = parseQuantity(q);
  return Number.isNaN(cores) ? NaN : cores * 1000;
}

/** Decode a base64 (Secret) value to a UTF-8 string; falls back to the input. */
export function decodeB64(v) {
  if (v == null) return '';
  try {
    const bin = atob(String(v));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return String(v);
  }
}

/** "1 pod" / "3 pods" — pass a custom plural for irregular nouns. */
export function pluralize(n, singular, plural = `${singular}s`) {
  return n === 1 ? singular : plural;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Integer with thousands separators: 1234 → "1,234". */
export function fmtInt(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat().format(Math.round(n));
}

/** Percentage with clamping: pct(3, 4) → "75%". */
export function pct(part, total, digits = 0) {
  if (!total) return '0%';
  return `${clamp((part / total) * 100, 0, 100).toFixed(digits)}%`;
}
