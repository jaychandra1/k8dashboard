import { useEffect, useRef } from 'react';

/**
 * A horizontal tab strip that overflows: no scrollbar (Windows draws a thick
 * one under the tabs), a fade on the side(s) with more tabs, the mouse wheel
 * scrolls it sideways, and the selected tab is kept in view.
 *
 *   const ref = useTabStripScroll(activeKey);
 *   <div ref={ref} className="resource-tabs" role="tablist">…</div>
 *
 * The fades are CSS, keyed off data-fade-start / data-fade-end.
 */
export default function useTabStripScroll(activeKey) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-fade-start', el.scrollLeft > 2);
      el.toggleAttribute('data-fade-end', max - el.scrollLeft > 2);
    };
    const onWheel = (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
      update();
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    const tab = el?.querySelector('[aria-selected="true"]');
    if (!el || !tab) return;
    // Scroll the strip only (scrollIntoView could also move the page).
    const left = tab.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft) el.scrollLeft = left - 24;
    else if (left + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + tab.offsetWidth - el.clientWidth + 24;
  }, [activeKey]);

  return ref;
}
