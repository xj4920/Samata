import type { PluginModule } from '@samata/plugin-sdk';
import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

function handleParseExcel(input: { file_path: string; sheet?: string; max_rows?: number }): string {
  const resolved = resolveFilePath(input.file_path);
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  try {
    const workbook = XLSX.readFile(resolved);
    const sheetName = input.sheet ?? workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return JSON.stringify({
        error: `Sheet "${sheetName}" 不存在`,
        available_sheets: workbook.SheetNames,
      });
    }

    const maxRows = input.max_rows ?? 500;
    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet);
    const truncated = rows.length > maxRows;
    const data = truncated ? rows.slice(0, maxRows) : rows;

    const headers = data.length > 0 ? Object.keys(data[0]) : [];

    return JSON.stringify({
      file: path.basename(resolved),
      sheet: sheetName,
      all_sheets: workbook.SheetNames,
      total_rows: rows.length,
      returned_rows: data.length,
      truncated,
      headers,
      data,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `解析失败: ${err.message}` });
  }
}

function handleListSheets(input: { file_path: string }): string {
  const resolved = resolveFilePath(input.file_path);
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  try {
    const workbook = XLSX.readFile(resolved);
    const sheets = workbook.SheetNames.map(name => {
      const ws = workbook.Sheets[name];
      const ref = ws['!ref'];
      const range = ref ? XLSX.utils.decode_range(ref) : null;
      return {
        name,
        rows: range ? range.e.r - range.s.r + 1 : 0,
        cols: range ? range.e.c - range.s.c + 1 : 0,
      };
    });
    return JSON.stringify({ file: path.basename(resolved), sheets });
  } catch (err: any) {
    return JSON.stringify({ error: `读取失败: ${err.message}` });
  }
}

const plugin: PluginModule = {
  name: 'excel-parser',
  description: '解析 Excel/CSV 文件，提取数据和结构信息',

  toolDefinitions: [
    {
      name: 'parse_excel',
      description: '解析 Excel/CSV 文件，返回指定 sheet 的数据。支持 .xlsx, .xls, .csv 格式。',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
          sheet: { type: 'string', description: 'Sheet 名称，默认第一个 sheet' },
          max_rows: { type: 'number', description: '最大返回行数，默认 500' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'list_excel_sheets',
      description: '列出 Excel 文件中所有 sheet 及其行列数',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
        },
        required: ['file_path'],
      },
    },
  ],

  async handleTool(name, input) {
    if (name === 'parse_excel') return handleParseExcel(input);
    if (name === 'list_excel_sheets') return handleListSheets(input);
    return null;
  },
};

export default plugin;
