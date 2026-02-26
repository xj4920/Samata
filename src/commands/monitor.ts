import { getDb } from '../db/connection.js';
import { STATES, STATE_LABELS, ClientState } from '../models/client.js';
import { renderTable } from '../utils/table.js';

export function status(): void {
  const db = getDb();
  const rows = db.prepare(
    'SELECT state, COUNT(*) as count FROM clients GROUP BY state'
  ).all() as { state: ClientState; count: number }[];

  const countMap = new Map(rows.map(r => [r.state, r.count]));
  const tableRows = STATES.map(s => [STATE_LABELS[s], String(countMap.get(s) ?? 0)]);

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  tableRows.push(['合计', String(total)]);

  renderTable(['阶段', '客户数'], tableRows);
}
