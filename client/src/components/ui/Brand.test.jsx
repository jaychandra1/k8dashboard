import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Brand from './Brand';

describe('Brand', () => {
  it('reads as "K8Board", with the 8 in its own (smaller) span', () => {
    const { container } = render(<p>Restart <Brand /> now.</p>);
    expect(container.textContent).toBe('Restart K8Board now.');
    expect(container.querySelector('.brand-word-8')).toHaveTextContent('8');
  });
});
