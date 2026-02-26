import XLSX from 'xlsx';

const workbook = XLSX.readFile('/Users/simon/topics/agent/data/customers/北向客户OnBoard-Last.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, any>[];

const statuses = new Set(rows.map(r => r['STAUS']));
console.log('All STATUS values:', [...statuses]);
console.log('Total rows:', rows.length);
