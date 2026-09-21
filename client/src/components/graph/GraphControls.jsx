import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';

/** Zoom in / out / reset buttons for a graph canvas (bottom-right overlay). */
export default function GraphControls({ onZoomIn, onZoomOut, onReset, resetLabel = 'Reset view' }) {
  return (
    <div className="topo-controls" role="group" aria-label="Graph zoom controls">
      <Tooltip content="Zoom in" placement="left">
        <Button variant="ghost" iconOnly icon="plus" iconSize={16} ariaLabel="Zoom in" className="topo-ctrl-btn" onClick={onZoomIn} />
      </Tooltip>
      <Tooltip content="Zoom out" placement="left">
        <Button variant="ghost" iconOnly icon="minus" iconSize={16} ariaLabel="Zoom out" className="topo-ctrl-btn" onClick={onZoomOut} />
      </Tooltip>
      <Tooltip content={resetLabel} placement="left">
        <Button variant="ghost" iconOnly icon="refresh" iconSize={15} ariaLabel={resetLabel} className="topo-ctrl-btn" onClick={onReset} />
      </Tooltip>
    </div>
  );
}

export { GraphControls };
