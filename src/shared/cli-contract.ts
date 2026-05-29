export interface CliUserInfo {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface CliSessionInfo {
  sessionId: string;
  user: CliUserInfo;
  agentName: string;
  agentDisplayName: string;
}

export interface CliExecuteResponse {
  ok: boolean;
  output: string[];
  session?: CliSessionInfo;
  error?: string;
}

export interface CliCommandEntry {
  name: string;
  description: string;
  usage?: string;
  subcommands?: string[];
}

export type CliStreamEvent =
  | { type: 'text';           chunk: string }
  | { type: 'tool_start';     name: string; input: unknown; round: number }
  | { type: 'tool_end';       name: string; result: string; round: number; durationMs: number }
  | { type: 'tool_progress';  message: string }
  | { type: 'thinking';       text: string; round: number }
  | { type: 'log';            line: string }
  | { type: 'prompt';         promptId: string; message: string; defaultValue?: string }
  | { type: 'done';           session: CliSessionInfo }
  | { type: 'error';          message: string }

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件',
  list_directory: '浏览目录', exec_cmd: '执行命令', reload_app: '重载应用',
  sandbox_exec: '执行代码', sandbox_write_file: '编写代码',
  sandbox_read_file: '读取结果', sandbox_list: '查看文件',
  search_knowledge: '搜索知识库', add_knowledge: '添加知识',
  update_knowledge: '更新知识', delete_knowledge: '删除知识',
  list_knowledge_recent: '查看最新知识',
  web_search: '搜索网络', web_fetch: '访问网页',
  query_trades: '查询交易', trade_summary: '交易汇总',
  plot_trades: '绘制图表', list_customers: '查询客户列表',
  export_trades_csv: '导出交易', export_north_info_csv: '导出北向信息',
  query_clients: '查询客户', view_client: '查看客户详情',
  get_client_history: '查看客户历史', add_client: '添加客户',
  update_client: '更新客户', import_pricing_schedule: '导入费率表',
  import_document: '导入文档', list_documents: '查看文档列表',
  add_health_record: '记录健康数据', query_health_records: '查询健康记录',
  health_summary: '健康汇总', log_sleep: '记录睡眠',
  log_meal: '记录饮食', log_symptom: '记录症状',
  set_medication_reminder: '设置用药提醒',
  list_skills: '查看技能', run_skill: '运行技能', save_skill: '保存技能',
  get_skill: '查看技能详情', delete_skill: '删除技能',
  list_agents: '查看助手列表', get_agent: '查看助手信息',
  switch_agent: '切换助手', save_agent: '保存助手配置',
  save_memory: '保存记忆', search_memory: '搜索记忆',
  update_memory: '更新记忆', delete_memory: '删除记忆',
  generate_image: '生成图片', generate_video: '生成视频',
  markdown_to_image: '渲染图片',
  send_file: '发送文件', send_image: '发送图片',
  calculate_date: '日期计算', set_reminder: '设置提醒',
  list_reminders: '查看提醒', cancel_reminder: '取消提醒',
  get_status_summary: '系统状态', http_request: '发送请求',
  write_artifact: '生成文件', download_file: '下载文件',
  create_todo: '创建待办', list_todos: '查看待办',
  update_todo: '更新待办', delete_todo: '删除待办',
  import_pricing_quote: '导入报价', query_pricing_quote: '查询报价',
  list_pricing_quote_dates: '查看报价日期',
  query_hedge_short: '查询对冲',
  sync_sbl_data: '同步SBL数据', analyze_sbl_usage: '分析SBL使用率',
  record_wrong_question: '记录错题', list_wrong_questions: '查看错题',
  wrong_question_report: '错题报告', mark_wrong_question_mastered: '标记已掌握',
  extract_wework_qa: '提取聊天问答',
  advance_client: '推进客户阶段', rollback_client: '回退客户阶段',
  delete_client: '删除客户', delete_document: '删除文档',
  assign_knowledge_agent: '分配知识', unassign_knowledge_agent: '取消分配知识',
  get_knowledge_agents: '查看知识归属',
  manage_agent_member: '管理助手成员', list_agent_members: '查看助手成员',
  assign_agent: '绑定助手', unassign_agent: '解绑助手',
  list_agent_assignments: '查看助手绑定',
  list_tool_presets: '查看工具预设',
};

export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (name === 'sandbox_exec' && typeof obj.code === 'string') {
    const lines = obj.code.split('\n').map(l => l.trim()).filter(Boolean);
    const comment = lines.find(l => l.startsWith('#') || l.startsWith('//'));
    if (comment) return comment.replace(/^[#/]+\s*/, '').slice(0, 50);
    const meaningful = lines.find(l => !l.startsWith('import ') && !l.startsWith('from '));
    if (meaningful) return meaningful.slice(0, 50);
  }

  if (name === 'sandbox_write_file' && obj.filename) {
    return String(obj.filename);
  }

  const keyword = obj.keyword ?? obj.query ?? obj.search ?? obj.path ?? obj.filename ?? obj.url ?? '';
  const brief = String(keyword).slice(0, 50).replace(/\n/g, ' ');
  if (brief) return brief;
  const firstVal = Object.values(obj).find(v => typeof v === 'string' && v.length > 0);
  return firstVal ? String(firstVal).slice(0, 50).replace(/\n/g, ' ') : '';
}

export function toolFriendlyLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('mcp_')) return name.slice(4).replace(/_/g, ' ');
  if (name.startsWith('query_') || name.startsWith('search_') || name.startsWith('list_')) return '查询数据';
  if (name.startsWith('add_') || name.startsWith('create_') || name.startsWith('save_')) return '保存数据';
  if (name.startsWith('update_') || name.startsWith('edit_')) return '更新数据';
  if (name.startsWith('delete_') || name.startsWith('remove_')) return '删除数据';
  if (name.startsWith('import_') || name.startsWith('export_')) return '导入导出';
  if (name.startsWith('send_')) return '发送消息';
  if (name.startsWith('get_') || name.startsWith('view_')) return '查看信息';
  return name;
}

const MAX_RESULT_SUMMARY = 80;

function truncResult(text: string, max = MAX_RESULT_SUMMARY): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/**
 * Extract a brief user-facing summary from a tool result string.
 * Designed for progress display in bot channels (~80 chars max).
 */
export function summarizeToolResult(name: string, result: string): string {
  if (!result) return '';

  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(result); } catch { /* non-JSON */ }

  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.error === 'string') {
      return truncResult(`❌ ${parsed.error}`);
    }

    if (name === 'sandbox_exec' || name === 'exec_cmd') {
      const files = parsed.generated_files;
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout.trim() : '';
      const stderr = typeof parsed.stderr === 'string' ? parsed.stderr.trim() : '';
      const exitCode = parsed.exit_code;

      if (exitCode !== 0 && exitCode !== undefined && stderr) {
        return truncResult(`❌ ${stderr.split('\n').pop() || stderr}`);
      }
      const userFiles = Array.isArray(files)
        ? files
            .map((f: any) => typeof f === 'string' ? f.split('/').pop() : f?.name || f?.path?.split('/').pop())
            .filter((n: string) => n && !n.endsWith('.pyc') && !/^_exec_\d+\.(py|js)$/.test(n))
        : [];
      if (stdout) {
        const lastMeaningful = stdout.split('\n').filter(Boolean).pop() || '';
        const suffix = userFiles.length > 0 ? ` → ${userFiles.join(', ')}` : '';
        return truncResult(lastMeaningful + suffix);
      }
      if (userFiles.length > 0) return truncResult(`生成文件: ${userFiles.join(', ')}`);
      return '';
    }

    if (name === 'sandbox_write_file') {
      const p = parsed.path ?? parsed.filename ?? parsed.file;
      if (typeof p === 'string') return truncResult(`已写入 ${p.split('/').pop()}`);
      if (typeof parsed.message === 'string') return truncResult(parsed.message);
      return '已写入';
    }

    for (const key of ['results', 'items', 'documents', 'records', 'files', 'rows', 'data']) {
      if (Array.isArray(parsed[key])) {
        const arr = parsed[key] as unknown[];
        const first = arr[0];
        let snippet = '';
        if (first && typeof first === 'object') {
          const o = first as Record<string, unknown>;
          snippet = String(o.title ?? o.name ?? o.summary ?? o.content ?? o.question ?? '').slice(0, 40);
        } else if (typeof first === 'string') {
          snippet = first.slice(0, 40);
        }
        const countPart = `${arr.length} 条结果`;
        return snippet ? truncResult(`${countPart}，首条: ${snippet}`) : countPart;
      }
    }

    if (typeof parsed.summary === 'string') return truncResult(parsed.summary);
    if (typeof parsed.message === 'string') return truncResult(parsed.message);
    if (typeof parsed.count === 'number') return `${parsed.count} 条`;
    if (typeof parsed.total === 'number') return `共 ${parsed.total} 条`;
    if (typeof parsed.path === 'string') return truncResult(parsed.path.split('/').pop() || parsed.path);
  }

  return truncResult(result);
}
