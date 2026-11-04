/**
 * The product name as it is shown in the UI: "K", a small "8", "Board".
 * Reads (and copies) as "K8Board". Use it wherever the name is visible text;
 * attributes (title, aria-label) and plain strings use "K8Board".
 *
 *   <p>Restart <Brand /> to finish the update.</p>
 */
export default function Brand({ className = '' }) {
  return <span className={`brand-word ${className}`.trim()}>K<span className="brand-word-8">8</span>Board</span>;
}

export { Brand };
