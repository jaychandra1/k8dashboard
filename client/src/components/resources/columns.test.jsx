import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { columnsFor } from './columns';
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
