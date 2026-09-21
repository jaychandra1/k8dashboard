import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ServicePortForward, { validatePort, portWarning } from './ServicePortForward';
import { ApiError } from '../lib/api';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), del: vi.fn() };
});
import { getJson, postJson, del } from '../lib/api';

describe('ServicePortForward', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockResolvedValue({ forwards: [] });
    postJson.mockResolvedValue({ id: 'pf-1', namespace: 'ns', name: 'svc', remotePort: 80, localPort: 8080, status: 'active' });
    del.mockResolvedValue({ success: true });
  });

  it('validates ports 1..65535 and warns below 1024', () => {
    expect(validatePort('')).toBeNull();
    expect(validatePort('0')).toMatch(/between 1 and 65535/);
    expect(validatePort('65536')).toMatch(/between 1 and 65535/);
    expect(validatePort('12a')).toMatch(/whole number/);
    expect(validatePort('8080')).toBeNull();
    expect(portWarning('80')).toMatch(/1024/);
    expect(portWarning('8080')).toBeNull();
  });

  it('shows an inline error for an invalid local port and never posts', async () => {
    const user = userEvent.setup();
    render(<ServicePortForward namespace="ns" name="svc" ports={[{ port: 80, protocol: 'TCP', name: 'http' }]} />);
    const input = screen.getByRole('textbox', { name: /Local port for service port 80/ });
    await user.type(input, '99999');
    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 65535/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const forward = screen.getByRole('button', { name: 'Forward port 80' });
    expect(forward).toBeDisabled();
    expect(postJson).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, '80');
    expect(screen.getByText(/elevated privileges/)).toBeInTheDocument();
    expect(forward).toBeEnabled();
  });

  it('starts a forward with numeric ports and lists a labelled Stop button', async () => {
    const user = userEvent.setup();
    render(<ServicePortForward namespace="ns" name="svc" ports={[{ port: 80 }]} />);
    await waitFor(() => expect(getJson).toHaveBeenCalledWith('/api/portforward', expect.anything()));
    await user.type(screen.getByRole('textbox', { name: /Local port for service port 80/ }), '8080');
    await user.click(screen.getByRole('button', { name: 'Forward port 80' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/portforward', { namespace: 'ns', name: 'svc', remotePort: 80, localPort: 8080 }));
    const stop = await screen.findByRole('button', { name: 'Stop forwarding port 80' });
    expect(screen.getByRole('link', { name: /localhost:8080/ })).toHaveAttribute('href', 'http://localhost:8080');
    await user.click(stop);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/portforward/pf-1'));
    expect(await screen.findByRole('button', { name: 'Forward port 80' })).toBeInTheDocument();
  });

  it('surfaces a 429 with a friendly message', async () => {
    const user = userEvent.setup();
    postJson.mockRejectedValueOnce(new ApiError({ status: 429, code: 'too_many_port_forwards', message: 'At most 10 port-forwards may be active at once' }));
    render(<ServicePortForward namespace="ns" name="svc" ports={[{ port: 443 }]} />);
    await user.click(screen.getByRole('button', { name: 'Forward port 443' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many active port-forwards/);
  });
});
