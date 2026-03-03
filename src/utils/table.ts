import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { log } from './logger.js';

marked.use(markedTerminal());

export function renderTable(head: string[], rows: string[][]): void {
  const sep = head.map(() => '---');
  const lines = [
    '| ' + head.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...rows.map(row => '| ' + row.map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'),
  ];
  const md = lines.join('\n');
  const rendered = (marked(md) as string).trimEnd();
  log.print(rendered);
}
