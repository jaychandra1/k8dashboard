import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown, { safeHref } from './Markdown';

describe('safeHref', () => {
  it('allows http(s), mailto, anchors and site-relative paths', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('#section')).toBe('#section');
    expect(safeHref('/pods/default')).toBe('/pods/default');
  });
  it('rejects javascript:, data:, protocol-relative and empty', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref('tel:123')).toBeNull();
  });
});

describe('Markdown', () => {
  it('renders unsafe links as plain text and safe links as anchors', () => {
    render(<Markdown text="[ok](https://a.b) and [bad](javascript:x) and [rel](//evil)" />);
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://a.b');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'rel' })).toBeNull();
    expect(screen.getByText('bad')).toBeInTheDocument();
  });
  it('does not italicise underscores inside snake_case identifiers', () => {
    const { container } = render(<Markdown text="use my_snake_case_var and _real italic_ here" />);
    const ems = container.querySelectorAll('em');
    expect(ems).toHaveLength(1);
    expect(ems[0].textContent).toBe('real italic');
    expect(container.textContent).toContain('my_snake_case_var');
  });
  it('renders code blocks, lists and headings', () => {
    const { container } = render(<Markdown text={'# Title\n\n- one\n- two\n\n```yaml\na: 1\n```'} />);
    expect(container.querySelector('h3.md-h')?.textContent).toBe('Title');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toBe('a: 1');
  });
});
