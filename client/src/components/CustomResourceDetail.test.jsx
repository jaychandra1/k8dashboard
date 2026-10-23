import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomResourceDetail from './CustomResourceDetail';
import { ToastProvider } from './Toast';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), putJson: vi.fn() };
});
import { getJson, putJson } from '../lib/api';

const CR = 'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w1\n  namespace: apps\nspec:\n  size: 3\n';

describe('CustomResourceDetail — an instance can be edited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockResolvedValue({ yaml: CR });
    putJson.mockResolvedValue({ message: 'widget.example.com/w1 serverside-applied' });
  });

  it('shows the YAML in the editor and applies changes to the custom resource', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <CustomResourceDetail selection={{ group: 'example.com', version: 'v1', plural: 'widgets', kind: 'Widget', name: 'w1', namespace: 'apps' }} onSelect={() => {}} />
      </ToastProvider>,
    );
    const path = '/api/customresource/example.com/v1/widgets/w1?namespace=apps';
    const ta = await screen.findByRole('textbox', { name: /YAML for Widget w1/ });
    await waitFor(() => expect(ta).toHaveValue(CR));
    expect(getJson).toHaveBeenCalledWith(path, expect.anything());
    expect(screen.getByRole('heading', { name: /w1/ })).toBeInTheDocument();

    await user.type(ta, '#');
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Apply changes to w1?' });
    await user.click(within(dlg).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(putJson).toHaveBeenCalledWith(path, { yaml: `${CR}#` }));
  }, 15000);

  it('a cluster-scoped instance is addressed without a namespace', async () => {
    render(
      <ToastProvider>
        <CustomResourceDetail selection={{ group: 'example.com', version: 'v1', plural: 'clusterwidgets', kind: 'ClusterWidget', name: 'c1', namespace: '-' }} onSelect={() => {}} />
      </ToastProvider>,
    );
    await screen.findByRole('textbox', { name: /YAML for ClusterWidget c1/ });
    expect(getJson).toHaveBeenCalledWith('/api/customresource/example.com/v1/clusterwidgets/c1', expect.anything());
  });
});
