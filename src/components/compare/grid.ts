/**
 * ONE COLUMN GRID for the sticky product header and every spec row under it,
 * so a value always sits under its product's photograph.
 *
 * Phone: the label is its own line above the cells (§10.3 «the label line, then
 * the cells on one grid row»), and the columns share the width. Wide: a label
 * column (the desktop table's sticky first column), then the products.
 */
export function columnsTemplate(columns: number, wide: boolean): string {
  const cols = `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`;
  return wide ? `minmax(150px, 200px) ${cols}` : cols;
}

/**
 * The gutter between columns, shared by the header and every row so a value
 * stays under its photograph. Four columns on a phone leave ~75 px each; the
 * 12 px gutter would spend 36 px of the screen on air, so it tightens to 8.
 */
export function columnGap(columns: number, wide: boolean): string {
  return !wide && columns >= 4 ? 'gap-x-2' : 'gap-x-3';
}
