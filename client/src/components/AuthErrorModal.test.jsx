import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AuthErrorModal, { classify } from './AuthErrorModal';

const SSO_STDERR = 'kubepilot token-helper: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login --profile sso-prod';

describe('AuthErrorModal classify — backend helper reasons', () => {
  it('maps sso-expired to the AWS SSO title with a sign-in action', () => {
    const c = classify({ reason: 'sso-expired', message: 'Your AWS SSO session has expired. Sign in again to refresh it.', detail: SSO_STDERR });
    expect(c.title).toBe('AWS SSO session expired');
    expect(c.fix).toMatchObject({ kind: 'aws', label: 'Sign in with AWS SSO', command: 'aws sso login --profile sso-prod' });
    expect(c.unmatched).toBeUndefined();
  });

  it('maps exec-helper to the helper title with Retry guidance', () => {
    const c = classify({ reason: 'exec-helper', message: 'The kubeconfig auth helper for this cluster failed to run. Its kubeconfig entry was out of date and has been repaired — click Retry.', detail: 'SyntaxError: Unexpected end of JSON input' });
    expect(c.title).toBe('Cluster auth helper failed');
    expect(c.summary).toMatch(/repaired/);
    expect(c.fix.kind).toBe('note');
  });
});

describe('AuthErrorModal rendering', () => {
  it('sso-expired: primary "Sign in with AWS SSO" opens the AWS add-cluster flow; raw stderr is under details', () => {
    const onAddAws = vi.fn();
    const onRetry = vi.fn();
    render(<AuthErrorModal auth={{ reason: 'sso-expired', message: 'Your AWS SSO session has expired. Sign in again to refresh it.', detail: SSO_STDERR, server: 'https://x.eks.amazonaws.com' }} onRetry={onRetry} onAddAws={onAddAws} />);
    expect(screen.getByText('AWS SSO session expired')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Sign in with AWS SSO/ });
    fireEvent.click(btn);
    expect(onAddAws).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.getByText(SSO_STDERR)).toBeInTheDocument();
  });

  it('exec-helper: title, note and Retry as the only primary action', () => {
    const onRetry = vi.fn();
    render(<AuthErrorModal auth={{ reason: 'exec-helper', message: 'The kubeconfig auth helper for this cluster failed to run. Click Retry; if it keeps failing, re-import the cluster from Add cluster.', detail: 'Unexpected end of JSON input' }} onRetry={onRetry} onAddAws={() => {}} />);
    expect(screen.getByText('Cluster auth helper failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers only real-cluster paths: Add cluster and Retry, never a Demo button', () => {
    render(<AuthErrorModal auth={{ reason: 'error', message: 'connection refused' }} onRetry={() => {}} onAddAws={() => {}} onAddAzure={() => {}} onChangeConfig={() => {}} />);
    expect(screen.getByRole('button', { name: /Add cluster/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /demo/i })).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });
});
