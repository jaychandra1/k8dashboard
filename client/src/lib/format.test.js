import { describe, it, expect } from 'vitest';
import { formatAge, formatAgeLong, formatAgeSeconds, parseHelmDate, fmtCpu, fmtMem, fmtMemMi, parseQuantity, cpuToMillicores, decodeB64, pluralize, clamp, pct } from './format';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();

describe('formatAge', () => {
  it('uses the compact k8s style', () => {
    expect(formatAge(ago(12), NOW)).toBe('12s');
    expect(formatAge(ago(5 * 60), NOW)).toBe('5m');
    expect(formatAge(ago(3 * 3600), NOW)).toBe('3h');
    expect(formatAge(ago(2 * 86400), NOW)).toBe('2d');
    expect(formatAge(ago(3 * 7 * 86400), NOW)).toBe('3w');
    expect(formatAge(ago(4 * 30 * 86400), NOW)).toBe('4mo');
    expect(formatAge(ago(400 * 86400), NOW)).toBe('1y');
  });
  it('handles missing, invalid and future input', () => {
    expect(formatAge(null, NOW)).toBe('-');
    expect(formatAge('nope', NOW)).toBe('-');
    expect(formatAge(new Date(NOW + 5000), NOW)).toBe('-');
  });
  it('accepts Date objects, epoch ms and Helm timestamps', () => {
    expect(formatAge(new Date(NOW - 90_000), NOW)).toBe('1m');
    expect(formatAge(NOW - 3600_000, NOW)).toBe('1h');
    expect(formatAge('2026-09-21 11:00:00.000000 +0000 UTC', NOW)).toBe('1h');
    expect(formatAge('2026-09-21 11:30:00.123456 +0000 UTC', NOW)).toBe('29m');
  });
  it('formatAgeSeconds works from a duration', () => {
    expect(formatAgeSeconds(90, NOW)).toBe('1m');
    expect(formatAgeSeconds(-1)).toBe('-');
  });
});

describe('formatAgeLong', () => {
  it('spells out units and pluralises', () => {
    expect(formatAgeLong(ago(3), NOW)).toBe('just now');
    expect(formatAgeLong(ago(60), NOW)).toBe('1 minute ago');
    expect(formatAgeLong(ago(5 * 60), NOW)).toBe('5 minutes ago');
    expect(formatAgeLong(ago(2 * 86400), NOW)).toBe('2 days ago');
    expect(formatAgeLong(undefined, NOW)).toBe('-');
  });
});

describe('parseHelmDate', () => {
  it('parses Helm timestamps with nanoseconds and zone', () => {
    const d = parseHelmDate('2024-01-02 15:04:05.123456789 +0000 UTC');
    expect(d.toISOString()).toBe('2024-01-02T15:04:05.123Z');
    expect(parseHelmDate('2024-01-02 15:04:05 +0530 IST').toISOString()).toBe('2024-01-02T09:34:05.000Z');
    expect(parseHelmDate('2024-01-02 15:04:05 UTC').toISOString()).toBe('2024-01-02T15:04:05.000Z');
  });
  it('returns null for garbage', () => {
    expect(parseHelmDate('')).toBeNull();
    expect(parseHelmDate('yesterday')).toBeNull();
  });
});

describe('cpu / memory', () => {
  it('fmtCpu', () => {
    expect(fmtCpu(250)).toBe('250m');
    expect(fmtCpu(1500)).toBe('1.50');
    expect(fmtCpu(null)).toBe('—');
  });
  it('fmtMem', () => {
    expect(fmtMem(35 * 1024 * 1024)).toBe('35Mi');
    expect(fmtMem(1.2 * 1024 ** 3)).toBe('1.2Gi');
    expect(fmtMem(12 * 1024 ** 3)).toBe('12Gi');
    expect(fmtMem(512 * 1024)).toBe('512Ki');
    expect(fmtMem(12)).toBe('12B');
  });
  it('fmtMemMi', () => {
    expect(fmtMemMi(512)).toBe('512 Mi');
    expect(fmtMemMi(1536)).toBe('1.50 Gi');
  });
  it('parseQuantity understands binary, decimal and cpu suffixes', () => {
    expect(parseQuantity('128Mi')).toBe(128 * 1024 ** 2);
    expect(parseQuantity('1.5Gi')).toBe(1.5 * 1024 ** 3);
    expect(parseQuantity('500m')).toBeCloseTo(0.5);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('1e3')).toBe(1000);
    expect(parseQuantity('100n')).toBeCloseTo(1e-7);
    expect(parseQuantity('5k')).toBe(5000);
    expect(parseQuantity(7)).toBe(7);
    expect(parseQuantity('abc')).toBeNaN();
  });
  it('cpuToMillicores', () => {
    expect(cpuToMillicores('500m')).toBeCloseTo(500);
    expect(cpuToMillicores('2')).toBe(2000);
  });
});

describe('misc', () => {
  it('decodeB64 decodes utf-8 and falls back on bad input', () => {
    expect(decodeB64('aGVsbG8=')).toBe('hello');
    expect(decodeB64('w7zDtsOk')).toBe('üöä');
    expect(decodeB64('***')).toBe('***');
    expect(decodeB64(null)).toBe('');
  });
  it('pluralize / clamp / pct', () => {
    expect(pluralize(1, 'pod')).toBe('pod');
    expect(pluralize(2, 'pod')).toBe('pods');
    expect(pluralize(2, 'policy', 'policies')).toBe('policies');
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(pct(3, 4)).toBe('75%');
    expect(pct(1, 0)).toBe('0%');
  });
});
