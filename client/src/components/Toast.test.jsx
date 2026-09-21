import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

let api;
function Grab() { api = useToast(); return null; }

describe('Toast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses role=status in a polite region and role=alert for errors in an assertive region', () => {
    render(<ToastProvider><Grab /></ToastProvider>);
    act(() => { api.info('hello'); api.error('boom'); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('hello');
    expect(status.parentElement).toHaveAttribute('aria-live', 'polite');
    expect(status.parentElement).toHaveAttribute('aria-relevant', 'additions');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('boom');
    expect(alert.parentElement).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2);
  });

  it('coalesces duplicates and extends the auto-dismiss timer', () => {
    render(<ToastProvider><Grab /></ToastProvider>);
    act(() => { api.success('saved'); });
    act(() => { vi.advanceTimersByTime(3000); });
    act(() => { api.success('saved'); }); // duplicate at t=3s → timer restarts
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('×2')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); }); // t=4s: would have expired under the old timer
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('bridges window "toast" events', () => {
    render(<ToastProvider><Grab /></ToastProvider>);
    act(() => { window.dispatchEvent(new CustomEvent('toast', { detail: { type: 'error', message: 'from window' } })); });
    expect(screen.getByRole('alert')).toHaveTextContent('from window');
  });
});
