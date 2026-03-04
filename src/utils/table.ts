import { renderMarkdown } from './markdown.js';
import { log } from './logger.js';

export function renderTable(head: string[], rows: string[][]): void {
  const sep = head.map(() => '---');
  const lines = [
    '| ' + head.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...rows.map(row => '| ' + row.map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'),
  ];
  const md = lines.join('\n');
  log.print(renderMarkdown(md));
}
