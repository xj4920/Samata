import { getDb } from '../db/connection.js';
import { STATES, STATE_LABELS, ClientState } from '../models/client.js';
import { renderTable } from '../utils/table.js';

export interface StatusRow {
  state: string;
  count: number;
}

export function fetchStatus(): StatusRow[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT state, COUNT(*) as count FROM clients GROUP BY state'
  ).all() as { state: ClientState; count: number }[];

  const countMap = new Map(rows.map(r => [r.state, r.count]));
  const result = STATES.map(s => ({ state: STATE_LABELS[s], count: countMap.get(s) ?? 0 }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  result.push({ state: '合计', count: total });
  return result;
}

export function status(): void {
  const data = fetchStatus();
  const tableRows = data.map(r => [r.state, String(r.count)]);
  renderTable(['阶段', '客户数'], tableRows);
}
