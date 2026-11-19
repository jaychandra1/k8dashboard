import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rememberConnection, rememberedConnection, forgetConnection } from './session';

describe('the cluster a window is connected to (for a reload)', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('is remembered for the window, replaced by the next cluster, and forgotten on request', () => {
    expect(rememberedConnection()).toBeNull();
    rememberConnection('dev');
    expect(rememberedConnection()).toBe('dev');
    rememberConnection('prod');
    expect(rememberedConnection()).toBe('prod');
    rememberConnection('');
    rememberConnection(null);
    expect(rememberedConnection()).toBe('prod');
    forgetConnection();
    expect(rememberedConnection()).toBeNull();
  });

  it('lives in the window only: nothing is kept across windows or restarts', () => {
    rememberConnection('dev');
    expect(Object.keys(sessionStorage)).toEqual(['k8board.connected']);
    expect(localStorage.getItem('k8board.connected')).toBeNull();
  });

  it('storage that refuses is not an error: there is just nothing remembered', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'])
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(() => rememberConnection('dev')).not.toThrow();
    expect(rememberedConnection()).toBeNull();
    expect(() => forgetConnection()).not.toThrow();
  });
});
