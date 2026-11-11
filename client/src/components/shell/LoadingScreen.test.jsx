import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoadingScreen, { loadingText } from './LoadingScreen';

describe('LoadingScreen', () => {
  it('renders a turning helm in a tile and "Getting the data…" as a polite status', () => {
    render(<LoadingScreen />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Getting the data…');
    // The mark is drawn, not an image file, and is decorative.
    expect(status.querySelector('img')).toBeNull();
    const mark = status.querySelector('.loading-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    const wheel = mark.querySelector('svg.loading-wheel');
    expect(wheel.querySelectorAll('line')).toHaveLength(7); // seven spokes
    expect(wheel.querySelectorAll('circle')).toHaveLength(2); // rim and hub
    expect(status.querySelector('.loading-screen-bar')).toHaveAttribute('aria-hidden', 'true');
    expect(status).not.toHaveAttribute('data-overlay');
  });

  it('names the cluster when known and shows an optional hint', () => {
    render(<LoadingScreen context="dev-env-cluster" hint="Checking cluster authentication…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Getting the data from dev-env-cluster…');
    expect(status).toHaveTextContent('Checking cluster authentication…');
    expect(loadingText('x')).toBe('Getting the data from x…');
    expect(loadingText()).toBe('Getting the data…');
  });

  it('connection steps: done ones are ticked, the current one is marked, later ones wait', () => {
    const steps = [{ key: 'config', label: 'Reading the kubeconfig entry' }, { key: 'auth', label: 'Signing in to the cluster' }, { key: 'summary', label: 'Loading the cluster summary' }];
    render(<LoadingScreen context="prod" steps={steps} step="auth" />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.dataset.state)).toEqual(['done', 'current', 'pending']);
    expect(items.map((li) => !!li.querySelector('.loading-step-mark svg'))).toEqual([true, false, false]);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items.map((li) => li.textContent)).toEqual(steps.map((s) => s.label));
  });

  it('marks the overlay variant so it covers only its positioned parent', () => {
    render(<LoadingScreen overlay context="prod" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-overlay', 'true');
  });
});
