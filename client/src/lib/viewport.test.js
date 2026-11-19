import { describe, test, expect, afterEach } from 'vitest';
import { titleBarHeight, floatingBounds, placeTooltip } from './viewport';

const setBar = (v) => (v == null ? document.documentElement.style.removeProperty('--titlebar-h') : document.documentElement.style.setProperty('--titlebar-h', v));
afterEach(() => setBar(null));

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
// A 1280 x 800 window: plain, and with the Windows title bar (36px).
const plain = { top: 8, left: 8, right: 1272, bottom: 792 };
const withBar = { top: 40, left: 8, right: 1272, bottom: 792 };
const tip = { width: 90, height: 28 };

describe('titleBarHeight / floatingBounds', () => {
  test('no app-drawn title bar: the whole window, an edge away from each side', () => {
    expect(titleBarHeight()).toBe(0);
    setBar('0px');
    expect(titleBarHeight()).toBe(0);
    expect(floatingBounds()).toEqual({ top: 8, left: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 });
  });

  test('Windows: floating UI starts below the title bar', () => {
    setBar('36px');
    expect(titleBarHeight()).toBe(36);
    expect(floatingBounds().top).toBe(40);
  });
});

describe('placeTooltip', () => {
  test('goes above the control, centred, when there is room', () => {
    const p = placeTooltip(rect(600, 300, 30, 28), tip, 'top', plain);
    expect(p).toEqual({ placement: 'top', top: 300 - 8 - 28, left: 600 + 15 - 45 });
  });

  test('a toolbar button right under the title bar: the tooltip opens below, not over the window buttons', () => {
    // The "AI settings" caret: 46px from the top, near the right edge.
    const caret = rect(1108, 46, 26, 28);
    const p = placeTooltip(caret, tip, 'top', withBar);
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(caret.bottom + 8);
    expect(p.top).toBeGreaterThanOrEqual(withBar.top);
  });

  test('without a title bar the same button still gets it below when the top of the window is too close', () => {
    expect(placeTooltip(rect(1108, 10, 26, 28), tip, 'top', plain).placement).toBe('bottom');
  });

  test('"bottom" flips up at the bottom of the window; left / right flip too', () => {
    expect(placeTooltip(rect(600, 770, 30, 20), tip, 'bottom', plain).placement).toBe('top');
    expect(placeTooltip(rect(20, 300, 30, 28), tip, 'left', plain).placement).toBe('right');
    expect(placeTooltip(rect(1240, 300, 30, 28), tip, 'right', plain).placement).toBe('left');
  });

  test('stays inside the window sideways (a control in the right corner)', () => {
    const p = placeTooltip(rect(1250, 300, 20, 20), { width: 200, height: 28 }, 'top', plain);
    expect(p.left).toBe(1272 - 200);
    expect(placeTooltip(rect(0, 300, 20, 20), { width: 200, height: 28 }, 'top', plain).left).toBe(8);
  });

  test('no room on either side: keeps the side asked for, clamped below the title bar', () => {
    const tall = { width: 90, height: 900 };
    const p = placeTooltip(rect(600, 300, 30, 28), tall, 'top', withBar);
    expect(p.placement).toBe('top');
    expect(p.top).toBe(withBar.top);
  });
});
