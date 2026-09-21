
/**
 * Spinner with an accessible status announcement.
 *
 *   <Loader label="Loading pods…" />            // visible label
 *   <Loader label={null} srLabel="Loading" />    // spinner only, text for SR
 *
 * For table/list placeholders prefer the foundation `<Skeleton rows cols />`
 * (components/ui/Skeleton) so the layout keeps its shape while loading; use
 * `<Loader>` for short, indeterminate waits (auth checks, modal steps).
 */
export default function Loader({ label = 'Loading…', srLabel, size = 30, inline = false, style }) {
  const text = label || srLabel || 'Loading';
  return (
    <div className={`loader ${inline ? 'inline' : ''}`} style={style} role="status" aria-live="polite">
      <span className="loader-spinner" style={{ width: size, height: size }} aria-hidden="true" />
      {label ? <span className="loader-label">{label}</span> : <span className="sr-only">{text}</span>}
    </div>
  );
}

export { Skeleton } from './ui/Skeleton';
