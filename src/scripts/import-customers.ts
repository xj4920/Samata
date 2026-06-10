import XLSX from 'xlsx';
import { initDatabase } from '../db/schema.js';
import { getDb, closeDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';

const STATUS_MAP: Record<string, string> = {
  'PROD': 'prod',
  'UAT->PROD': 'uat',
  'UAT': 'uat',
  'PENDING': 'initial_contact',
};

async function importCustomers(): Promise<void> {
  await initDatabase();
  const db = getDb();

  const workbook = XLSX.readFile('/Users/simon/topics/agent/data/customers/北向客户OnBoard-Last.xlsx');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, any>[];

  const insertClient = db.prepare(`
    INSERT INTO clients (id, name, contact, state, wework_group, requirements, sales, tags, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (id, entity_type, entity_id, action, payload, performed_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Clear existing clients and related events
  db.exec('DELETE FROM events WHERE entity_type = \'client\'');
  db.exec('DELETE FROM clients');

  const tx = db.transaction(() => {
    let count = 0;
    for (const row of rows) {
      const name = row['NAME'];
      if (!name) continue;

      const id = uuid();
      const state = STATUS_MAP[row['STAUS']] ?? 'initial_contact';
      const contacts = row['CONTACTS'] ?? null;
      const weworkGroup = row['WeWork Group'] ?? null;
      const requirements = row['REQUIREMENTS'] ?? null;
      const sales = row['SALES'] ?? null;
      const iface = row['INTERFACE'] ?? null;
      const speed = row['常/极速'] ?? null;
      const dualCenter = row['双中心'] ?? null;
      const dedicatedLine = row['专线'] ?? null;
      const chatRooms = row['CHAT_ROOMS'] ?? null;
      const accounts = row['ACCOUNT'] ?? null;
      const tradeType = row['交易类型'] ?? null;
      const notes = row['备注'] ?? null;

      // tags: INTERFACE(API/FIX), 常/极速, 双中心, 专线
      const tagParts: string[] = [];
      if (iface) tagParts.push(iface);
      if (speed) tagParts.push(speed);
      if (dualCenter && dualCenter !== '否') tagParts.push('双中心');
      if (dedicatedLine && dedicatedLine !== '否') tagParts.push('专线');
      const tags = tagParts.length > 0 ? tagParts.join(',') : null;

      const fullNotes = [
        chatRooms ? `群: ${chatRooms}` : null,
        accounts ? `账户: ${accounts}` : null,
        tradeType ? `交易类型: ${tradeType}` : null,
        notes ? `备注: ${notes}` : null,
      ].filter(Boolean).join('\n');

      insertClient.run(id, name, contacts, state, weworkGroup, requirements, sales, tags, fullNotes || null, 'admin-001');
      insertEvent.run(uuid(), 'client', id, 'import', JSON.stringify({ source: '北向客户OnBoard-Last.xlsx', original_status: row['STAUS'] }), 'admin-001');
      count++;
    }
    return count;
  });

  const count = tx();
  console.log(`成功导入 ${count} 条客户数据`);
  closeDb();
}

importCustomers();
