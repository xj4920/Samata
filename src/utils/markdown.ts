import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Lightweight markdown-to-terminal renderer using chalk.
 * Replaces the broken marked + marked-terminal combo.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table block: consecutive lines starting with |
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(renderTableBlock(tableLines));
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = inlineFormat(headingMatch[2]);
      if (depth <= 2) {
        out.push(chalk.bold.green(text));
      } else {
        out.push(chalk.bold(text));
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push(chalk.dim('─'.repeat(40)));
      i++;
      continue;
    }

    // Regular line (inline formatting only)
    out.push(inlineFormat(line));
    i++;
  }

  return out.join('\n');
}

/** Apply inline markdown formatting: bold, italic, code, strikethrough */
function inlineFormat(text: string): string {
  // Code spans (must be first to avoid inner processing)
  text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code));
  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => chalk.bold.italic(t));
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
  // Italic
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => chalk.italic(t));
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t));
  return text;
}

/** Render a markdown table block using cli-table3 */
function renderTableBlock(tableLines: string[]): string {
  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map(c => c.trim());

  if (tableLines.length < 2) return tableLines.join('\n');

  const header = parseRow(tableLines[0]);
  // Skip separator row (line 1)
  const rows = tableLines.slice(2).map(parseRow);

  const table = new Table({
    head: header.map(h => chalk.cyan(inlineFormat(h))),
    style: { head: [], border: ['gray'] },
  });
  for (const row of rows) {
    table.push(row.map(cell => inlineFormat(cell)));
  }
  return table.toString();
}
