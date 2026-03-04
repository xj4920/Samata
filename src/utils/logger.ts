import pino from 'pino';
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

const logFilePath = path.join(logsDir, getLogFileName());

// 创建 pino 实例（仅写文件）
const logger = pino({
  level: 'debug',
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: {
          destination: logFilePath,
        },
      },
    ],
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

export const log = {
  /** 终端彩色输出 + 写入日志文件（info 级别） */
  info: (msg: string) => { console.log(chalk.cyan(msg)); logger.info(msg); },
  /** 终端彩色输出 + 写入日志文件（info 级别） */
  success: (msg: string) => { console.log(chalk.green(msg)); logger.info(msg); },
  /** 终端彩色输出 + 写入日志文件（warn 级别） */
  warn: (msg: string) => { console.log(chalk.yellow(msg)); logger.warn(msg); },
  /** 终端彩色输出 + 写入日志文件（error 级别） */
  error: (msg: string) => { console.log(chalk.red(msg)); logger.error(msg); },
  /** 终端暗色输出 + 写入日志文件（debug 级别） */
  dim: (msg: string) => { console.log(chalk.dim(msg)); logger.debug(msg); },
  /** 仅写入日志文件，不输出到终端 */
  file: (msg: string) => { logger.info(msg); },
  /** 仅输出到终端，不写日志文件（用于 CLI 交互显示） */
  print: (...args: any[]) => console.log(...args),
};
