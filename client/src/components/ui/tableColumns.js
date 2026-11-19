// Sizing helpers for <DataTable> columns (see "Column widths" in DataTable.jsx).
//
// Every table names a width for every column, so a column is exactly that wide
// whatever its rows hold and the table doesn't move as rows scroll, sort or
// filter into view. A width covers the column's header and its usual values;
// longer values are cut with an ellipsis and shown in the cell's tooltip.

/** The least a sortable column needs for its header: padding, the label in capitals, the sort arrow. */
export const HEADER_ROOM = (label) => 48 + Math.ceil(String(label).length * 8.5);

/**
 * The room the longest name in `rows` needs, in px: its text (about 6.6px a
 * character), the icon before it and the cell padding. A name column passes
 * this as `fit` so it grows past its width only when a name needs it.
 */
export const nameRoom = (rows) =>
  56 + Math.ceil(6.6 * rows.reduce((n, r) => Math.max(n, r?.name?.length || 0), 0));
