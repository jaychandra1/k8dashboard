import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LogsViewer, { TAIL_OPTIONS, MAX_LOG_PODS } from './LogsViewer';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn() };
});
import { getJson } from '../lib/api';

const LOGS = [
  '2024-01-01T00:00:00.000Z hello world',
  '2024-01-01T00:00:01.000Z ERROR something failed',
  'plain line without timestamp',
].join('\n');

describe('LogsViewer', () => {
  beforeEach(() => { vi.clearAllMocks(); getJson.mockResolvedValue({ logs: LOGS }); });

  it('offers the bounded tail options (no "All") and fetches with tail=1000 by default', async () => {
    render(<LogsViewer namespace="ns" pod="web-1" containers={['app']} />);
    expect(TAIL_OPTIONS).toEqual([200, 1000, 5000, 20000]);
    const select = screen.getByRole('combobox', { name: 'Lines to show' });
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['200', '1000', '5000', '20000']);
    expect(values).not.toContain('0');
    await waitFor(() => expect(getJson).toHaveBeenCalled());
    expect(getJson).toHaveBeenCalledWith('/api/logs/ns/web-1', expect.objectContaining({ params: expect.objectContaining({ tail: 1000, container: 'app', timestamps: true }) }));
    await screen.findByText(/hello world/);
    expect(screen.getByRole('log', { name: 'Logs for web-1' })).toHaveAttribute('aria-live', 'off');
  });

  it('refetches when the tail changes', async () => {
    const user = userEvent.setup();
    render(<LogsViewer namespace="ns" pod="web-1" containers={['app']} />);
    await screen.findByText(/hello world/);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lines to show' }), '5000');
    await waitFor(() => expect(getJson).toHaveBeenLastCalledWith('/api/logs/ns/web-1', expect.objectContaining({ params: expect.objectContaining({ tail: 5000 }) })));
  });

  it('searches and highlights matches with a live count', async () => {
    const user = userEvent.setup();
    render(<LogsViewer namespace="ns" pod="web-1" containers={['app']} />);
    await screen.findByText(/hello world/);
    await user.type(screen.getByRole('searchbox', { name: 'Search in logs' }), 'failed');
    expect(screen.getByText('1 / 1 matches')).toBeInTheDocument();
    const mark = document.querySelector('mark.logs-hl');
    expect(mark).toHaveTextContent('failed');
    // regex guard: an invalid pattern never throws
    await user.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await user.clear(screen.getByRole('searchbox', { name: 'Search in logs' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search in logs' }), '(');
    expect(screen.getByText('invalid regex')).toBeInTheDocument();
  });

  it('follow mode turns the log region polite', async () => {
    const user = userEvent.setup();
    render(<LogsViewer namespace="ns" pod="web-1" containers={['app']} />);
    await screen.findByText(/hello world/);
    await user.click(screen.getByRole('button', { name: /Follow logs/ }));
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('LogsViewer — workload mode (a Deployment\'s pods)', () => {
  const PODS = [
    { name: 'web-7c8f-aaa', containerNames: ['app'], status: 'Running' },
    { name: 'web-7c8f-bbb', containerNames: ['app'], status: 'Pending' },
  ];
  const BY_POD = {
    '/api/logs/shop/web-7c8f-aaa': ['2024-01-01T00:00:00.000Z first from aaa', '2024-01-01T00:00:02.000Z third from aaa'].join('\n'),
    '/api/logs/shop/web-7c8f-bbb': ['2024-01-01T00:00:01.000Z second from bbb'].join('\n'),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockImplementation(async (url) => ({ logs: BY_POD[url] || '' }));
  });

  it('"All pods" reads every replica and merges the lines chronologically, prefixed with the pod', async () => {
    render(<LogsViewer namespace="shop" workload={{ kind: 'Deployment', name: 'web' }} pods={PODS} />);
    const picker = screen.getByRole('combobox', { name: 'Pod' });
    expect(picker).toHaveValue('');
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['All pods (2)', 'web-7c8f-aaa', 'web-7c8f-bbb (Pending)']);
    await screen.findByText(/third from aaa/);
    expect(getJson).toHaveBeenCalledWith('/api/logs/shop/web-7c8f-aaa', expect.objectContaining({ params: expect.objectContaining({ container: 'app', tail: 1000 }) }));
    expect(getJson).toHaveBeenCalledWith('/api/logs/shop/web-7c8f-bbb', expect.anything());
    const rows = Array.from(document.querySelectorAll('.logs-row'));
    expect(rows.map((r) => r.querySelector('.logs-msg').textContent)).toEqual(['first from aaa', 'second from bbb', 'third from aaa']);
    // Prefixes name the pod without the deployment-name prefix.
    expect(rows.map((r) => r.querySelector('.logs-cname').textContent)).toEqual(['[7c8f-aaa]', '[7c8f-bbb]', '[7c8f-aaa]']);
    expect(screen.getByRole('log', { name: 'Logs for web' })).toBeInTheDocument();
    expect(screen.getByText(/Deployment:/).parentElement).toHaveTextContent('Pod: all 2');
  });

  it('picking one replica reads only that pod', async () => {
    const user = userEvent.setup();
    render(<LogsViewer namespace="shop" workload={{ kind: 'Deployment', name: 'web' }} pods={PODS} />);
    await screen.findByText(/third from aaa/);
    getJson.mockClear();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pod' }), 'web-7c8f-bbb');
    await screen.findByText(/second from bbb/);
    await waitFor(() => expect(screen.queryByText(/third from aaa/)).toBeNull());
    expect(getJson.mock.calls.map((c) => c[0])).toEqual(['/api/logs/shop/web-7c8f-bbb']);
    expect(screen.getByText(/Deployment:/).parentElement).toHaveTextContent('Pod: web-7c8f-bbb');
  });

  it('shows what it could read when a replica fails, and flags the missing source', async () => {
    getJson.mockImplementation(async (url) => {
      if (url.endsWith('web-7c8f-bbb')) throw Object.assign(new Error('container "app" is waiting to start'), { status: 400 });
      return { logs: BY_POD[url] };
    });
    render(<LogsViewer namespace="shop" workload={{ kind: 'Deployment', name: 'web' }} pods={PODS} />);
    await screen.findByText(/third from aaa/);
    expect(screen.getByText('1 source unavailable')).toHaveAttribute('title', expect.stringMatching(/7c8f-bbb: .*waiting to start/));
  });

  it('caps "All pods" at MAX_LOG_PODS replicas', async () => {
    const many = Array.from({ length: MAX_LOG_PODS + 3 }, (_, i) => ({ name: `web-x-${i}`, containerNames: ['app'] }));
    render(<LogsViewer namespace="shop" workload={{ kind: 'Deployment', name: 'web' }} pods={many} totalPods={many.length} />);
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(MAX_LOG_PODS));
    expect(screen.getByRole('combobox', { name: 'Pod' }).options[0].textContent).toBe(`All pods (first ${MAX_LOG_PODS} of ${many.length})`);
  });
});
