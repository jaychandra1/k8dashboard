import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { columnsFor, COLUMN_TYPES, HEADER_ROOM, nameRoom } from './columns';
import { columnSizing } from '../ui/DataTable';
import { statusTone } from '../../lib/status';

// The row shape comes from lib/resource-format.mjs (server + demo).
const cellText = (col, row) => {
  const out = col.render ? col.render(row, 0) : row[col.key];
  if (out == null || typeof out !== 'object') return String(out ?? '');
  return render(<>{out}</>).container.textContent;
};
const headers = (type) => columnsFor(type, { icon: 'box' }).map((c) => (typeof c.header === 'string' ? c.header : ''));

describe('columns for the workload kinds', () => {
  it('Replica Sets: desired / current / ready like kubectl, and who controls them', () => {
    expect(headers('replicaSet')).toEqual(['Name', 'Namespace', 'Desired', 'Current', 'Ready', 'Controlled By', 'Age']);
    const cols = columnsFor('replicaSet', { icon: 'replicaSet' });
    const row = { name: 'web-7f9c6d5b4', namespace: 'shop', desired: 3, current: 3, ready: 2, owner: 'Deployment web', createdAt: new Date().toISOString() };
    expect(cols.map((c) => cellText(c, row)).slice(2, 6)).toEqual(['3', '3', '2', 'Deployment web']);
    expect(headers('replicationController')).toEqual(['Name', 'Namespace', 'Desired', 'Current', 'Ready', 'Age']);
  });

  it('Jobs: completions, duration, owner and status', () => {
    expect(headers('job')).toEqual(['Name', 'Namespace', 'Status', 'Completions', 'Duration', 'Controlled By', 'Age']);
    const cols = columnsFor('job', { icon: 'job' });
    const row = { name: 'backup-1', namespace: 'shop', completions: '1/1', durationSeconds: 200, owner: 'CronJob backup', status: 'Complete' };
    expect(cellText(cols[3], row)).toBe('1/1');
    expect(cellText(cols[4], row)).toBe('3m');
    expect(cellText(cols[4], { ...row, durationSeconds: null })).toBe('—');
    expect(cellText(cols[2], row)).toContain('Complete');
  });

  it('Cron Jobs: schedule, last schedule, active jobs and status', () => {
    expect(headers('cronJob')).toEqual(['Name', 'Namespace', 'Status', 'Schedule', 'Last Schedule', 'Active', 'Age']);
    const cols = columnsFor('cronJob', { icon: 'cronJob' });
    const row = { name: 'backup', namespace: 'shop', schedule: '0 2 * * *', lastSchedule: new Date(Date.now() - 3 * 3600_000).toISOString(), activeJobs: 0, status: 'Scheduled' };
    expect(cellText(cols[3], row)).toBe('0 2 * * *');
    expect(cellText(cols[4], row)).toBe('3h ago');
    expect(cellText(cols[4], { ...row, lastSchedule: null })).toBe('—');
  });

  it('status colours: suspended is a choice (muted), running / active is in progress (info), failed is bad', () => {
    expect(statusTone('job', 'Complete')).toBe('ok');
    expect(statusTone('job', 'Failed')).toBe('bad');
    expect(statusTone('job', 'Running')).toBe('info');
    expect(statusTone('job', 'Suspended')).toBe('muted');
    expect(statusTone('cronJob', 'Active')).toBe('info');
    expect(statusTone('cronJob', 'Scheduled')).toBe('info');
    expect(statusTone('cronJob', 'Suspended')).toBe('muted');
  });
});

// The lists use <DataTable fixedColumns>: a column is exactly as wide as it says,
// so the table doesn't move as rows scroll or sort into view.
describe('column widths: every list is laid out the same whatever its rows hold', () => {
  const kinds = [...COLUMN_TYPES, 'someOtherKind'];

  it('every column of every kind names a width that fits its header', () => {
    for (const kind of kinds) {
      for (const col of columnsFor(kind, { icon: 'box' })) {
        expect(Number.isFinite(col.width), `${kind}.${col.key} has no width`).toBe(true);
        if (typeof col.header === 'string')
          expect(col.width, `${kind}.${col.key} is narrower than its header`).toBeGreaterThanOrEqual(HEADER_ROOM(col.header));
      }
    }
  });

  it('so no column is sized by its cells: the name is 300px, stretching when names need it; the last takes the rest', () => {
    for (const kind of kinds) {
      const cols = columnsFor(kind, { icon: 'box' });
      const sizing = columnSizing(cols, { fixed: true, selectable: true, actions: true });
      expect(sizing.every((s) => s.fixed), kind).toBe(true);
      // Short names: exactly 300px (no gap after them). Long names: room for them, up to 460px.
      expect(sizing[0].th, kind).toEqual({ width: 300, minWidth: 300, maxWidth: 300 });
      const long = columnSizing(cols, { fixed: true, selectable: true, actions: true, fit: 2000 });
      expect(long[0].th.width, kind).toMatch(/^clamp\(300px, calc\(100cqw - \d+px\), 460px\)$/);
      expect(sizing.at(-1).th.width, kind).toBe('100%');
      expect(cols.filter((c) => c.fill).map((c) => c.key), kind).toEqual([cols.at(-1).key]);
    }
  });

  it('the room a list of names needs follows its longest name', () => {
    expect(nameRoom([])).toBe(56);
    // 36 characters fit the 300px column; 45 need more.
    expect(nameRoom([{ name: 'ec2-inventory-refresh-29905920-4hbtb' }, { name: 'short' }])).toBeLessThanOrEqual(300);
    expect(nameRoom([{ name: 'kube-prometheus-stack-operator-6f8b7c9d5-abcde' }, {}, null])).toBeGreaterThan(300);
    expect(columnsFor('pod', { icon: 'box' })[0].fit).toBe(nameRoom);
  });

  it('a value that can be cut short is in the tooltip: text columns, the status and the secret type', () => {
    const cols = (kind) => Object.fromEntries(columnsFor(kind, { icon: 'box' }).map((c) => [c.key, c]));
    expect(cols('pod').status.title({ status: 'CreateContainerConfigError' })).toBe('CreateContainerConfigError');
    expect(cols('pod').status.title({})).toBe('Unknown');
    expect(cols('pod').status.width).toBe(160);
    expect(cols('ingress').hosts.ellipsis).toBe(true);
    expect(cols('ingress').hosts.title({ hosts: 'shop.example.com, api.example.com' })).toBe('shop.example.com, api.example.com');
    expect(cols('ingress').hosts.title({ hosts: '' })).toBeUndefined();
    expect(cols('secret').secretType.title({ secretType: 'kubernetes.io/service-account-token' })).toBe('kubernetes.io/service-account-token');
  });
});
