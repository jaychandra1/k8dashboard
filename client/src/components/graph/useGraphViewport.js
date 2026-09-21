import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from '../../lib/format';

/**
 * Pan / zoom state for an SVG canvas: mouse drag, wheel zoom, and keyboard
 * (arrow keys pan, + / - zoom, 0 resets) while the canvas itself is focused.
 *
 *   const vp = useGraphViewport({ initial: { x: 40, y: 40 } });
 *   <div {...vp.canvasProps} className={vp.dragging ? 'dragging' : ''}>
 *     <svg><g transform={vp.transform}>…</g></svg>
 *   </div>
 */
export default function useGraphViewport({ initial = { x: 40, y: 40 }, min = 0.3, max = 2, step = 0.15, wheelStep = 0.12, panStep = 40 } = {}) {
  const initX = initial.x; const initY = initial.y;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: initX, y: initY });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);

  const reset = useCallback(() => { setZoom(1); setPan({ x: initX, y: initY }); }, [initX, initY]);
  const zoomBy = useCallback((d) => setZoom((z) => clamp(+(z + d).toFixed(2), min, max)), [min, max]);
  const zoomIn = useCallback(() => zoomBy(step), [zoomBy, step]);
  const zoomOut = useCallback(() => zoomBy(-step), [zoomBy, step]);
  const panBy = useCallback((dx, dy) => setPan((p) => ({ x: p.x + dx, y: p.y + dy })), []);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  }, [pan.x, pan.y]);

  // Window listeners only while a drag is in progress.
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
    };
    const up = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [dragging]);

  const onWheel = useCallback((e) => { zoomBy(e.deltaY < 0 ? wheelStep : -wheelStep); }, [zoomBy, wheelStep]);

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

  const canvasProps = useMemo(() => ({ onMouseDown, onWheel, onKeyDown, tabIndex: 0 }), [onMouseDown, onWheel, onKeyDown]);
  const transform = `translate(${pan.x}, ${pan.y}) scale(${zoom})`;
  return { zoom, pan, dragging, reset, zoomIn, zoomOut, panBy, canvasProps, transform };
}

export { useGraphViewport };

export const GRAPH_KEY_HINT = 'Arrow keys pan, plus and minus zoom, 0 resets the view.';
