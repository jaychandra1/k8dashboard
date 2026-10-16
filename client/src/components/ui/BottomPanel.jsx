import Button from './Button';
import useContentFullscreen, {
  FullscreenContext,
  usePanelFullscreen,
} from '../../hooks/useContentFullscreen';

/**
 * The docked bottom panel (Resources, Nodes, Helm, Access Control) with full
 * screen: maximized, the whole panel — tab strip first, then the active tab —
 * covers the content area while the sidebar and top bar stay visible. The
 * viewers inside (logs, YAML, terminal) toggle the same state from their own
 * toolbars (usePanelFullscreen).
 *
 * `besideDrawer`: a details drawer is open on the page — the panel ends where
 * the drawer begins (normal and full screen) instead of running underneath
 * it, so its tabs and controls stay visible.
 *
 *   <BottomPanel as="section" aria-label="…" besideDrawer={!!selected}>
 *     <div className="bottom-panel-tabs">… <PanelFullscreenToggle label="logs" /> <Button … close /></div>
 *     <div className="bottom-panel-content">…</div>
 *   </BottomPanel>
 */
export default function BottomPanel({
  as: Tag = 'div',
  besideDrawer = false,
  className = '',
  children,
  ...rest
}) {
  const fs = useContentFullscreen();
  return (
    <FullscreenContext.Provider value={fs}>
      <Tag
        {...rest}
        className={`bottom-panel${fs.on ? ' is-fullscreen' : ''}${besideDrawer ? ' beside-drawer' : ''}${className ? ` ${className}` : ''}`}
        style={fs.style}
      >
        {children}
      </Tag>
    </FullscreenContext.Provider>
  );
}

/** Maximize / minimize button for the tab strip, next to its close button. */
export function PanelFullscreenToggle({ label = 'panel' }) {
  const fs = usePanelFullscreen();
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon={fs.on ? 'minimize' : 'maximize'}
      ariaLabel={fs.on ? `Minimize ${label} (exit full screen)` : `Show ${label} full screen`}
      title={fs.on ? 'Minimize (Esc)' : 'Full screen'}
      className="bottom-panel-toggle"
      onClick={fs.toggle}
    />
  );
}
