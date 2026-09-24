// Branded loading screen: app icon (gentle pulse, off under
// prefers-reduced-motion), "Getting the data…" (+ cluster name when known)
// and a thin indeterminate bar. Announced once via role=status.
//
//   <LoadingScreen />                                  startup (no context yet)
//   <LoadingScreen context="dev-env-cluster" />        "Getting the data from dev-env-cluster…"
//   <LoadingScreen context hint="Checking cluster authentication…" />
//   <LoadingScreen overlay context />                  absolutely covers its positioned parent (main)
//
// `overlay` covers only the region it is rendered in (App renders it inside
// <main>, so the sidebar and top bar stay usable); it is not a modal.
export function loadingText(context) {
  return context ? `Getting the data from ${context}…` : 'Getting the data…';
}

export default function LoadingScreen({ context, label, hint, overlay = false, className = '' }) {
  const text = label || loadingText(context);
  return (
    <div
      className={`loading-screen ${className}`.trim()}
      data-overlay={overlay || undefined}
      role="status"
      aria-live="polite"
    >
      <img className="loading-screen-logo" src="/logo.png" alt="" width={72} height={72} decoding="async" />
      <p className="loading-screen-text">{text}</p>
      {hint && <p className="loading-screen-hint">{hint}</p>}
      <div className="loading-screen-bar" aria-hidden="true"><span /></div>
    </div>
  );
}

export { LoadingScreen };
