import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ApplyManifestModal, { countDocuments, EXAMPLES } from './ApplyManifestModal';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, postJson: vi.fn() };
});
import { postJson, ApiError } from '../lib/api';

const TWO_DOCS = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n';
const ok = (dryRun) => ({
  success: true,
  dryRun,
  results: [
    { ok: true, label: 'configmap/a', namespace: 'team', message: `configmap/a serverside-applied${dryRun ? ' (server dry run)' : ''}` },
    { ok: true, label: 'configmap/b', namespace: 'team', message: `configmap/b serverside-applied${dryRun ? ' (server dry run)' : ''}` },
  ],
});

// Role lookups walk the whole dialog, including the highlighted editor layer;
// under parallel test load they can take longer than the 1 s default.
const SLOW = { timeout: 5000 };

function setup(props = {}) {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<ApplyManifestModal open onClose={onClose} onApplied={onApplied} namespaces={['all', 'default', 'team']} defaultNamespace="team" context="dev-env-cluster" {...props} />);
  const editor = screen.getByRole('textbox', { name: /Manifests \(YAML\)/ });
  return { onClose, onApplied, editor, user: userEvent.setup() };
}

describe('countDocuments', () => {
  it('counts YAML documents, ignoring empty and comment-only ones', () => {
    expect(countDocuments('')).toBe(0);
    expect(countDocuments('# just a comment\n')).toBe(0);
    expect(countDocuments(TWO_DOCS)).toBe(2);
    expect(countDocuments(`---\n${TWO_DOCS}---\n`)).toBe(2);
    expect(countDocuments('a: 1\n--- # second\nb: 2')).toBe(2);
  });
});

describe('ApplyManifestModal', { timeout: 15000 }, () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('validates with a server-side dry run: nothing is applied and the parent is not refreshed', async () => {
    postJson.mockResolvedValue(ok(true));
    const { user, editor, onApplied } = setup();
    expect(screen.getByRole('button', { name: /Validate/ })).toBeDisabled();
    await user.click(editor);
    await user.paste(TWO_DOCS);
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Validate \(dry run\)/ }));
    expect(postJson).toHaveBeenCalledWith('/api/apply', { yaml: TWO_DOCS, dryRun: true, namespace: 'team' });
    expect(await screen.findByText('Dry run passed for 2 resources — nothing was changed.', {}, SLOW)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('applies after a confirmation naming the cluster and namespace, then refreshes the list', async () => {
    postJson.mockResolvedValue(ok(false));
    const { user, editor, onApplied } = setup();
    await user.click(editor);
    await user.paste(TWO_DOCS);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const confirm = await screen.findByRole('dialog', { name: 'Apply 2 manifests?' }, SLOW);
    expect(confirm).toHaveTextContent('dev-env-cluster');
    expect(confirm).toHaveTextContent('namespace team');
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Apply' }));
    expect(postJson).toHaveBeenCalledWith('/api/apply', { yaml: TWO_DOCS, dryRun: false, namespace: 'team' });
    expect(await screen.findByText('Applied 2 resources.', {}, SLOW)).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('lists each failed document with the API server reason; refreshes if some were applied', async () => {
    postJson.mockRejectedValue(new ApiError({
      status: 422,
      code: 'apply_failed',
      message: '1 of 2 manifests failed — configmap/b: admission webhook denied the request: nope',
      body: { results: [ok(false).results[0], { ok: false, label: 'configmap/b', error: 'admission webhook denied the request: nope' }] },
    }));
    const { user, editor, onApplied } = setup({ defaultNamespace: '' });
    await user.click(editor);
    await user.paste(TWO_DOCS);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Apply 2 manifests?' }, SLOW)).getByRole('button', { name: 'Apply' }));
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert).toHaveTextContent('1 applied, 1 failed.');
    expect(alert).toHaveTextContent('configmap/b');
    expect(alert).toHaveTextContent('admission webhook denied the request: nope');
    expect(postJson).toHaveBeenCalledWith('/api/apply', { yaml: TWO_DOCS, dryRun: false, namespace: undefined });
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('shows a validation error from the server (nothing applied)', async () => {
    postJson.mockRejectedValue(new ApiError({ status: 400, code: 'invalid_yaml', message: 'Document 2: Manifest is missing metadata.name', body: { error: 'Document 2: Manifest is missing metadata.name' } }));
    const { user, editor, onApplied } = setup();
    await user.click(editor);
    await user.paste(TWO_DOCS);
    await user.click(screen.getByRole('button', { name: /Validate \(dry run\)/ }));
    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent('Document 2: Manifest is missing metadata.name');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('inserts examples and opens .yaml files, separating documents with ---', async () => {
    const { user, editor } = setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Insert an example manifest' }), 'Deployment');
    expect(editor.value).toBe(EXAMPLES.Deployment);
    const file = new File(['apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-file\n'], 'cm.yaml', { type: 'text/yaml' });
    await user.upload(document.querySelector('input[type="file"]'), file);
    await waitFor(() => expect(editor.value).toContain('# File: cm.yaml'));
    expect(editor.value).toContain('kind: Deployment');
    expect(editor.value).toMatch(/\n---\n# File: cm\.yaml\napiVersion: v1/);
    expect(screen.getByText('2 documents')).toBeInTheDocument();
  });

  it('offers every real namespace plus the context default', () => {
    setup();
    const select = screen.getByRole('combobox', { name: 'Namespace for manifests without one' });
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'default', 'team']);
    expect(select).toHaveValue('team');
  });
});
