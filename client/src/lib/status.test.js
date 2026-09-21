import { describe, it, expect } from 'vitest';
import { statusTone, statusClass, statusBgClass, podPhaseBucket, BUCKET_TONE } from './status';

describe('statusTone', () => {
  it('maps the canonical ok statuses', () => {
    for (const s of ['Running', 'Ready', 'Bound', 'Active', 'Succeeded', 'Completed', 'Healthy', 'Synced', 'deployed']) {
      expect(statusTone('pod', s)).toBe('ok');
    }
  });
  it('maps warn statuses', () => {
    for (const s of ['Pending', 'ContainerCreating', 'Terminating', 'Progressing', 'Unknown', 'OutOfSync']) {
      expect(statusTone('pod', s)).toBe('warn');
    }
  });
  it('maps bad statuses (Degraded is bad, not warn)', () => {
    for (const s of ['Failed', 'CrashLoopBackOff', 'Error', 'ImagePullBackOff', 'ErrImagePull', 'OOMKilled', 'Evicted', 'NotReady', 'Degraded', 'Missing']) {
      expect(statusTone('pod', s)).toBe('bad');
    }
  });
  it('is case-insensitive and works with a single argument', () => {
    expect(statusTone('running')).toBe('ok');
    expect(statusTone('CRASHLOOPBACKOFF')).toBe('bad');
  });
  it('falls back to muted, handles init: prefixes and heuristics', () => {
    expect(statusTone('pod', 'Whatever')).toBe('muted');
    expect(statusTone('pod', '')).toBe('muted');
    expect(statusTone('pod', null)).toBe('muted');
    expect(statusTone('pod', 'Init:CrashLoopBackOff')).toBe('bad');
    expect(statusTone('pod', 'Init:0/2')).toBe('warn');
    expect(statusTone('pod', 'ErrImageNeverPull')).toBe('bad');
  });
  it('applies per-kind overrides', () => {
    expect(statusTone('argocd', 'Progressing')).toBe('info');
    expect(statusTone('node', 'Unknown')).toBe('bad');
    expect(statusTone('persistentVolume', 'Released')).toBe('warn');
  });
});

describe('statusClass', () => {
  it('produces tone classes', () => {
    expect(statusClass('ok')).toBe('tone-ok');
    expect(statusClass('nonsense')).toBe('tone-muted');
    expect(statusBgClass('bad')).toBe('bg-tone-bad');
  });
});

describe('podPhaseBucket', () => {
  it('buckets by phase', () => {
    expect(podPhaseBucket({ status: 'Running' })).toBe('running');
    expect(podPhaseBucket({ status: 'Pending' })).toBe('pending');
    expect(podPhaseBucket({ status: 'Failed' })).toBe('failed');
    expect(podPhaseBucket({ status: 'Succeeded' })).toBe('succeeded');
    expect(podPhaseBucket({ status: 'Unknown' })).toBe('unknown');
    expect(podPhaseBucket(null)).toBe('unknown');
  });
  it('treats container-level failures as failed even when phase is Running', () => {
    expect(podPhaseBucket({ status: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] })).toBe('failed');
    expect(podPhaseBucket({ status: { phase: 'Running', containerStatuses: [{ state: { terminated: { reason: 'OOMKilled' } } }] } })).toBe('failed');
  });
  it('has a tone per bucket', () => {
    expect(Object.keys(BUCKET_TONE)).toEqual(['running', 'pending', 'failed', 'succeeded', 'unknown']);
  });
});
