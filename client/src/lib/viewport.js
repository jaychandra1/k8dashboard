// Where floating UI (tooltips, menus) may be drawn.
//
// On Windows the app draws its own title bar and the system paints the
// minimise / maximise / close buttons over its right end, above the page. So
// anything that strays into that strip is cut off by them. `--titlebar-h` (set
// in App.css; 0 where the system draws the title bar) is the strip's height.

const EDGE = 8; // the gap kept to every side of the window

/** Height of the app-drawn title bar in px (0 where there is none). */
export function titleBarHeight() {
  if (typeof document === 'undefined') return 0;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** The rectangle floating UI has to stay inside: below the title bar, EDGE from the sides. */
export function floatingBounds() {
  const bar = titleBarHeight();
  return {
    top: bar ? bar + 4 : EDGE,
    left: EDGE,
    right: window.innerWidth - EDGE,
    bottom: window.innerHeight - EDGE,
  };
}

/**
 * Position a tooltip of size `tip` next to the `anchor` rectangle.
 * It goes on the side asked for, moves to the opposite side when it doesn't
 * fit there (a toolbar button right under the title bar: below, not above),
 * and is then kept inside `bounds`. Returns { top, left, placement }.
 */
export function placeTooltip(anchor, tip, placement = 'top', bounds = floatingBounds(), gap = 8) {
  const room = {
    top: anchor.top - gap - tip.height >= bounds.top,
    bottom: anchor.bottom + gap + tip.height <= bounds.bottom,
    left: anchor.left - gap - tip.width >= bounds.left,
    right: anchor.right + gap + tip.width <= bounds.right,
  };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const side = !room[placement] && room[opposite[placement]] ? opposite[placement] : placement;

  let top;
  let left;
  if (side === 'top' || side === 'bottom') {
    top = side === 'top' ? anchor.top - gap - tip.height : anchor.bottom + gap;
    left = anchor.left + anchor.width / 2 - tip.width / 2;
  } else {
    top = anchor.top + anchor.height / 2 - tip.height / 2;
    left = side === 'left' ? anchor.left - gap - tip.width : anchor.right + gap;
  }
  left = Math.max(bounds.left, Math.min(left, bounds.right - tip.width));
  top = Math.max(bounds.top, Math.min(top, bounds.bottom - tip.height));
  return { top, left, placement: side };
}
