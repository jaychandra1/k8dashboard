import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from '../../lib/format';

/**
 * Pan / zoom state for an SVG canvas: mouse drag, wheel zoom (anchored at the
 * cursor), and keyboard (arrow keys pan, + / - zoom, 0 fits/resets) while the
 * canvas itself is focused. Knows the content size so it can FIT the graph to
 * the canvas — on first render, when the content changes, and on Reset.
 *
 *   const vp = useGraphViewport({ padding: 40 });
 *   useEffect(() => { vp.setContent({ width, height }); }, [width, height]);
 *   <div ref={vp.canvasRef} {...vp.canvasProps} className={vp.dragging ? 'dragging' : ''}>
 *     <svg><g transform={vp.transform}>…</g></svg>
 *   </div>
 */
export default function useGraphViewport({
  initial = { x: 40, y: 40 },
  min = 0.1,
  max = 2.5,
  step = 0.15,
  wheelStep = 0.12,
  panStep = 40,
  padding = 40,
  maxFitZoom = 1,
} = {}) {
  const initX = initial.x; const initY = initial.y;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: initX, y: initY });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  const canvasRef = useRef(null);
  const contentRef = useRef({ width: 0, height: 0 });
  // Once the user pans/zooms by hand, canvas resizes no longer auto-refit.
  const userAdjusted = useRef(false);
  const zoomRef = useRef(1); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;

  const canvasSize = () => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
  };

  /** Scale and centre the known content inside the canvas (never above maxFitZoom). */
  const fit = useCallback(() => {
    const c = contentRef.current;
    const cs = canvasSize();
    if (!cs || !(c.width > 0) || !(c.height > 0)) { setZoom(1); setPan({ x: initX, y: initY }); return; }
    const avail = { w: Math.max(50, cs.width - padding * 2), h: Math.max(50, cs.height - padding * 2) };
    const z = clamp(+Math.min(avail.w / c.width, avail.h / c.height, maxFitZoom).toFixed(3), min, max);
    setZoom(z);
    setPan({
      x: Math.round((cs.width - c.width * z) / 2),
      y: Math.round(Math.max(padding, (cs.height - c.height * z) / 2)),
    });
    userAdjusted.current = false;
  }, [initX, initY, padding, maxFitZoom, min, max]);

  /** Tell the viewport how big the drawn content is; refits unless the user has adjusted the view. */
  const setContent = useCallback((size) => {
    const w = Number(size?.width) || 0, h = Number(size?.height) || 0;
    const changed = w !== contentRef.current.width || h !== contentRef.current.height;
    contentRef.current = { width: w, height: h };
    if (changed) fit();
  }, [fit]);

  // Reset = fit (falls back to the initial offset when no content is known).
  const reset = useCallback(() => { fit(); }, [fit]);

  const zoomAt = useCallback((factor, anchor) => {
    const z0 = zoomRef.current;
    const z1 = clamp(+(z0 * factor).toFixed(3), min, max);
    if (z1 === z0) return;
    const p0 = panRef.current;
    if (anchor) {
      // Keep the content point under the anchor fixed: pan' = a - (a - pan) * z1/z0
      const k = z1 / z0;
      setPan({ x: anchor.x - (anchor.x - p0.x) * k, y: anchor.y - (anchor.y - p0.y) * k });
    }
    setZoom(z1);
    userAdjusted.current = true;
  }, [min, max]);
  const centreAnchor = useCallback(() => { const cs = canvasSize(); return cs ? { x: cs.width / 2, y: cs.height / 2 } : null; }, []);
  const zoomIn = useCallback(() => zoomAt(1 + step, centreAnchor()), [zoomAt, step, centreAnchor]);
  const zoomOut = useCallback(() => zoomAt(1 / (1 + step), centreAnchor()), [zoomAt, step, centreAnchor]);
  const panBy = useCallback((dx, dy) => { userAdjusted.current = true; setPan((p) => ({ x: p.x + dx, y: p.y + dy })); }, []);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
    setDragging(true);
  }, []);

  // Window listeners only while a drag is in progress.
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      userAdjusted.current = true;
      setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
    };
    const up = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [dragging]);

  const onWheel = useCallback((e) => {
    const el = canvasRef.current;
    const r = el ? el.getBoundingClientRect() : null;
    const anchor = r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
    zoomAt(e.deltaY < 0 ? 1 + wheelStep : 1 / (1 + wheelStep), anchor);
  }, [zoomAt, wheelStep]);

  const onKeyDown = useCallback((e) => {
    if (e.target !== e.currentTarget) return; // a focused node handles its own keys
    switch (e.key) {
      case 'ArrowLeft': panBy(panStep, 0); break;
      case 'ArrowRight': panBy(-panStep, 0); break;
      case 'ArrowUp': panBy(0, panStep); break;
      case 'ArrowDown': panBy(0, -panStep); break;
      case '+': case '=': zoomIn(); break;
      case '-': case '_': zoomOut(); break;
      case '0': reset(); break;
      default: return;
    }
    e.preventDefault();
  }, [panBy, panStep, zoomIn, zoomOut, reset]);

  // Refit when the canvas itself is resized (window resize, drawer open),
  // unless the user has taken control of the view.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!userAdjusted.current) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const canvasProps = useMemo(() => ({ onMouseDown, onWheel, onKeyDown, tabIndex: 0 }), [onMouseDown, onWheel, onKeyDown]);
  const transform = `translate(${pan.x}, ${pan.y}) scale(${zoom})`;
  return { zoom, pan, dragging, reset, fit, setContent, zoomIn, zoomOut, panBy, canvasProps, canvasRef, transform };
}

export { useGraphViewport };

export const GRAPH_KEY_HINT = 'Arrow keys pan, plus and minus zoom, 0 fits the whole graph.';
