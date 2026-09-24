import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoadingScreen, { loadingText } from './LoadingScreen';

describe('LoadingScreen', () => {
  it('renders the app icon and "Getting the data…" as a polite status', () => {
    render(<LoadingScreen />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Getting the data…');
    const logo = status.querySelector('img.loading-screen-logo');
    expect(logo).toHaveAttribute('src', '/logo.png');
    expect(logo).toHaveAttribute('width', '72');
    expect(logo).toHaveAttribute('alt', ''); // decorative
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

  it('marks the overlay variant so it covers only its positioned parent', () => {
    render(<LoadingScreen overlay context="prod" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-overlay', 'true');
  });
});
