import { useEffect, useState } from 'react';
import { onThemeChange } from '../lib/tokens';

/**
 * Re-render the caller when the theme flips, so colours resolved through
 * `toneColor()` / `cssVar()` at render time (SVG fills) follow the theme.
 * Returns a counter you can put in a `useMemo` dependency list.
 */
export default function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => onThemeChange(() => setTick((t) => t + 1)), []);
  return tick;
}

export { useThemeTick };
