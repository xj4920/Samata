/**
 * 根据上传文件名生成针对性的 LLM 引导提示，避免默认都走 parse_excel。
 * wework / feishu bot 下载文件后共用此函数。
 */
export function buildFileHint(filename: string, savedPath: string, bytes: number): string {
  const base = `用户发送了文件 "${filename}" (${bytes} bytes)，已保存到本地路径: ${savedPath}`;

  if (/pricing[\s_+-]*schedule|claw|客户报价/i.test(filename)) {
    return `${base}\n这是**客户报价条款表**（按管理人聚合 commission / financing / 点差 等），请直接调用 import_pricing_schedule（默认 dry_run=true 预览；用户确认后 dry_run=false 写入）。**不要**用 parse_excel 展示 + 手动 query_clients 逐条匹配——Counterparty 是产品名（如 WIZARD01、MINGSHIOPTIMA），query_clients 按管理人名匹配，一定查不到；import_pricing_schedule 内部会通过 config/customers.json 自动聚合到管理人。`;
  }

  if (/fxd|frn/i.test(filename)) {
    return `${base}\n这是**产品利率报价表**（Fixed/Floating × 货币 × tenor），请直接调用 import_pricing_quote（默认 dry_run=true 预览；用户确认后 dry_run=false 写入），不要用 parse_excel 仅作展示。`;
  }

  return `${base}\n请使用合适的工具（parse_word、parse_excel、read_file 等）读取文件内容。`;
}
