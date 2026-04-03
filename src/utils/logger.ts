
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

// 确保 logs 目录存在
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// 生成带日期的日志文件名
const getLogFileName = () => {
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  return `app-${date}.log`;
};

const getLogFilePath = () => path.join(logsDir, getLogFileName());

function formatLogEntry(level: string, msg: string): string {
  const timestamp = new Date().toISOString();
  const normalized = String(msg ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const [firstLine = '', ...restLines] = lines;
  const header = `[${timestamp}] [${level.toUpperCase()}] ${firstLine}`;
  if (restLines.length === 0) return `${header}\n`;
  const body = restLines.map(line => `  ${line}`).join('\n');
  return `${header}\n${body}\n`;
}

function writeToFile(level: string, msg: string): void {
  fs.appendFileSync(getLogFilePath(), formatLogEntry(level, msg), 'utf8');
}

export const log = {
  /** 终端彩色输出 + 写入日志文件（info 级别） */
  info: (msg: string) => { console.log(chalk.cyan(msg)); writeToFile('info', msg); },
  /** 终端彩色输出 + 写入日志文件（info 级别） */
  success: (msg: string) => { console.log(chalk.green(msg)); writeToFile('info', msg); },
  /** 终端彩色输出 + 写入日志文件（warn 级别） */
  warn: (msg: string) => { console.log(chalk.yellow(msg)); writeToFile('warn', msg); },
  /** 终端彩色输出 + 写入日志文件（error 级别） */
  error: (msg: string) => { console.log(chalk.red(msg)); writeToFile('error', msg); },
  /** 终端暗色输出 + 写入日志文件（debug 级别） */
  dim: (msg: string) => { console.log(chalk.dim(msg)); writeToFile('debug', msg); },
  /** 仅写入日志文件，不输出到终端 */
  file: (msg: string) => { writeToFile('info', msg); },
  /** 仅输出到终端，不写日志文件（用于 CLI 交互显示） */
  print: (...args: any[]) => console.log(...args),
};
