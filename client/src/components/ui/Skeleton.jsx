
/**
 * Table-shaped loading placeholder: <Skeleton rows={8} cols={5} />
 * Also usable as a block: <Skeleton block height={120} />
 */
export default function Skeleton({ rows = 6, cols = 4, block = false, height, width, label = 'Loading', className = '' }) {
  if (block) {
    return <div className={`ui-skeleton ui-skeleton-block ${className}`.trim()} style={{ height, width }} role="status" aria-label={label} />;
  }
  return (
    <div className={`ui-skeleton-table ${className}`.trim()} role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, r) => (
        <div className="ui-skeleton-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <span className="ui-skeleton ui-skeleton-cell" key={c} style={{ width: `${[38, 22, 14, 18, 26, 12][c % 6]}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export { Skeleton };
