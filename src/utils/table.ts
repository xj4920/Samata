import Table from 'cli-table3';

function truncate(str: string, max: number): string {
  const flat = str.replace(/[\r\n]+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 3) + '...';
}

export interface ColumnDef {
  width?: number;
}

export function renderTable(head: string[], rows: string[][], cols?: ColumnDef[]): void {
  const colWidths = cols?.map(c => c.width);
  const table = new Table({
    head,
    style: { head: ['cyan'] },
    ...(colWidths ? { colWidths } : {}),
  });
  for (const row of rows) {
    const truncated = cols
      ? row.map((cell, i) => cols[i]?.width ? truncate(cell, cols[i].width! - 2) : cell)
      : row;
    table.push(truncated);
  }
  console.log(table.toString());
}
