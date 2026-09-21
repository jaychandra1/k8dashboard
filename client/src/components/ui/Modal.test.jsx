import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal, { ConfirmModal } from './Modal';
import Button from './Button';
import Badge from './Badge';
import SearchBox from './SearchBox';
import Donut from './Donut';

describe('Modal', () => {
  it('renders into #modal-root with dialog semantics and closes on Escape/backdrop', async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Scale" description="Pick a count"><input aria-label="Replicas" /></Modal>);
    const dlg = screen.getByRole('dialog', { name: 'Scale' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveAccessibleDescription('Pick a count');
    expect(document.getElementById('modal-root')).toContainElement(dlg);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByLabelText('Replicas')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dlg.parentElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('traps Tab focus and restores focus on close', async () => {
    const user = userEvent.setup();
    const Outer = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          <Modal open={open} onClose={() => setOpen(false)} title="T" showClose={false}>
            <button>one</button><button>two</button>
          </Modal>
        </>
      );
    };
    render(<Outer />);
    const opener = screen.getByText('open');
    opener.focus();
    await user.click(opener);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByText('one')).toHaveFocus();
    await user.tab();
    expect(screen.getByText('two')).toHaveFocus();
    await user.tab();
    expect(screen.getByText('one')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText('two')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="X">body</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ConfirmModal', () => {
  it('requires the typed value before enabling confirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmModal open title="Delete pod" message="Really?" confirmLabel="Delete" danger requireTyped="web-1" onConfirm={onConfirm} onCancel={() => {}} />);
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type/), 'web-1');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('primitives', () => {
  it('Button is type=button with variant/size data attrs and busy state', () => {
    render(<Button variant="danger" size="sm" icon="delete" busy>Delete</Button>);
    const b = screen.getByRole('button', { name: 'Delete' });
    expect(b).toHaveAttribute('type', 'button');
    expect(b).toHaveAttribute('data-variant', 'danger');
    expect(b).toHaveAttribute('data-size', 'sm');
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
  });
  it('Button iconOnly uses ariaLabel', () => {
    render(<Button iconOnly icon="more" ariaLabel="Actions for web" />);
    expect(screen.getByRole('button', { name: 'Actions for web' })).toBeInTheDocument();
  });
  it('Badge derives tone from status and shows text', () => {
    render(<Badge status="CrashLoopBackOff" kind="pod" />);
    const el = screen.getByText('CrashLoopBackOff').closest('.ui-badge');
    expect(el).toHaveAttribute('data-tone', 'bad');
  });
  it('SearchBox is labelled and clearable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchBox value="abc" onChange={onChange} ariaLabel="Search pods" />);
    expect(screen.getByRole('searchbox', { name: 'Search pods' })).toHaveValue('abc');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
  it('Donut exposes a title and text summary', () => {
    render(<Donut ariaLabel="Pod status" segments={[{ label: 'Running', value: 3, tone: 'ok' }, { label: 'Failed', value: 1, tone: 'bad' }]} legend />);
    expect(screen.getByRole('img', { name: 'Pod status' })).toBeInTheDocument();
    expect(screen.getByText('Pod status: Running: 3, Failed: 1')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});
