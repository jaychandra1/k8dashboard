import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Menu from './Menu';

// Longer than the 220 ms the menu waits before closing a submenu.
const pastCloseDelay = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });

const setup = () => {
  const onAws = vi.fn();
  const onClose = vi.fn();
  render(
    <Menu
      open
      ariaLabel="Switch cluster"
      onClose={onClose}
      items={[
        { key: 'pin', label: 'Pin', onSelect: () => {} },
        { key: 'add', label: 'Add cluster', children: [
          { key: 'aws', label: 'AWS EKS', onSelect: onAws },
          { key: 'azure', label: 'Azure AKS', onSelect: () => {} },
        ] },
      ]}
    />
  );
  const add = screen.getByRole('menuitem', { name: 'Add cluster' });
  fireEvent.mouseEnter(add);
  return { onAws, onClose, add };
};

describe('Menu submenus with the mouse', () => {
  it('a submenu stays open while the pointer moves into it, so its items can be clicked', async () => {
    const { onAws, onClose, add } = setup();
    const aws = screen.getByRole('menuitem', { name: 'AWS EKS' });
    // Leaving "Add cluster" for the submenu: the parent list gets mouseleave,
    // the submenu gets mouseenter.
    fireEvent.mouseOut(add, { relatedTarget: aws });
    await pastCloseDelay();
    expect(screen.getByRole('menu', { name: 'Add cluster' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'AWS EKS' }));
    expect(onAws).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('select');
  });

  it('moving back from the submenu to its parent item keeps it open', async () => {
    const { add } = setup();
    const aws = screen.getByRole('menuitem', { name: 'AWS EKS' });
    fireEvent.mouseOut(add, { relatedTarget: aws });
    fireEvent.mouseOut(aws, { relatedTarget: add });
    await pastCloseDelay();
    expect(screen.getByRole('menu', { name: 'Add cluster' })).toBeInTheDocument();
  });

  it('closes the submenu after a moment once the pointer has left both menus', async () => {
    const { add } = setup();
    const aws = screen.getByRole('menuitem', { name: 'AWS EKS' });
    fireEvent.mouseOut(add, { relatedTarget: aws });
    fireEvent.mouseOut(aws, { relatedTarget: document.body });
    expect(screen.getByRole('menu', { name: 'Add cluster' })).toBeInTheDocument();
    await pastCloseDelay();
    expect(screen.queryByRole('menu', { name: 'Add cluster' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Switch cluster' })).toBeInTheDocument();
  });

  it('hovering another item of the parent closes the submenu', () => {
    const { add } = setup();
    fireEvent.mouseOut(add, { relatedTarget: screen.getByRole('menuitem', { name: 'Pin' }) });
    expect(screen.queryByRole('menu', { name: 'Add cluster' })).toBeNull();
  });
});
