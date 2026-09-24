import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import YamlViewer from './YamlViewer';
import { ToastProvider } from './Toast';
import { ApiError } from '../lib/api';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), putJson: vi.fn() };
});
import { getJson, putJson } from '../lib/api';

const YAML = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-1\n';

function renderYaml(props = {}) {
  return render(
    <ToastProvider>
      <YamlViewer namespace="ns" kind="pod" name="web-1" {...props} />
    </ToastProvider>,
  );
}

describe('YamlViewer', () => {
  beforeEach(() => { vi.clearAllMocks(); getJson.mockResolvedValue({ yaml: YAML }); putJson.mockResolvedValue({ message: 'pod/web-1 configured' }); });

  it('keeps the highlight layer and the textarea in one scroll container (no drifting caret)', async () => {
    renderYaml({ onClose: () => {} });
    const ta = await screen.findByRole('textbox', { name: /YAML for pod web-1/ });
    const stack = ta.parentElement;
    expect(stack).toHaveClass('yaml-edit-stack');
    expect(stack.parentElement).toHaveClass('yaml-edit-scroll');
    const pre = stack.querySelector('pre.yaml-code');
    expect(pre).toHaveAttribute('aria-hidden', 'true');
    expect(pre.nextElementSibling?.tagName === 'LABEL' || pre.nextElementSibling === ta).toBe(true);
    // If the browser scrolls the textarea itself, it snaps back to 0,0.
    ta.scrollTop = 40; ta.scrollLeft = 12;
    fireEvent.scroll(ta);
    expect(ta.scrollTop).toBe(0);
    expect(ta.scrollLeft).toBe(0);
  });

  it('loads YAML into a labelled textarea and applies only after confirmation', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    renderYaml({ onApplied });
    const ta = await screen.findByRole('textbox', { name: /YAML for pod web-1/ });
    await waitFor(() => expect(ta).toHaveValue(YAML));
    expect(getJson).toHaveBeenCalledWith('/api/yaml/ns/pod/web-1', expect.anything());
    expect(ta).toHaveAccessibleDescription(/Press (⌘S|Ctrl\+S) to apply/);
    const apply = screen.getByRole('button', { name: /Apply/ });
    expect(apply).toBeDisabled();

    await user.type(ta, '#');
    expect(apply).toBeEnabled();
    await user.click(apply);
    const dlg = await screen.findByRole('dialog', { name: 'Apply changes to web-1?' });
    expect(putJson).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(putJson).toHaveBeenCalledTimes(1));
    expect(putJson.mock.calls[0][0]).toBe('/api/yaml/ns/pod/web-1');
    expect(putJson.mock.calls[0][1].yaml).toBe(`${YAML}#`);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 15000);

  it('shows server errors inline with role=alert', async () => {
    const user = userEvent.setup();
    putJson.mockRejectedValueOnce(new ApiError({ status: 400, code: 'yaml_mismatch', message: 'YAML kind "Deployment" does not match the path (pod)' }));
    renderYaml();
    const ta = await screen.findByRole('textbox', { name: /YAML for pod web-1/ });
    await waitFor(() => expect(ta).toHaveValue(YAML));
    await user.type(ta, 'x');
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Apply' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/doesn't match this resource/);
    expect(ta).toHaveAttribute('aria-invalid', 'true');
  });

  it('guards closing with unsaved changes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderYaml({ onClose });
    const ta = await screen.findByRole('textbox', { name: /YAML for pod web-1/ });
    await waitFor(() => expect(ta).toHaveValue(YAML));
    await user.click(screen.getByRole('button', { name: /Close YAML editor/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.type(ta, 'x');
    await user.click(screen.getByRole('button', { name: /Close YAML editor/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const dlg = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dlg).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
