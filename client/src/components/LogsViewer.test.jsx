import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LogsViewer, { TAIL_OPTIONS } from './LogsViewer';

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
