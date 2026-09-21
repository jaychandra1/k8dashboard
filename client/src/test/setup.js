import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// jsdom lacks a few browser APIs the UI relies on.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
}
if (!window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
if (!window.cancelAnimationFrame) window.cancelAnimationFrame = (id) => clearTimeout(id);
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
