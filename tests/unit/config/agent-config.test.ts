import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, setMockMcpTools, teardownDb, withContext, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('getAgentTools', () => {
  let ctx: UnitTestContext;
  const legacyHedgeMigrationTool = ['migrate', 'hedge', 'ratio', 'in' + 'flux', 'history'].join('_');

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  async function getToolNames(agentName: string, isAdmin = true, channel = 'cli') {
    const { getAgent, getAgentTools } = await import('../../../src/llm/agents/config.js');
    const { getGlobalTools } = await import('../../../src/llm/agent.js');
    const agent = getAgent(agentName);
    const globalTools = getGlobalTools();
    return withContext({ channel, role: isAdmin ? 'admin' : 'member', agentName }, () => {
      const tools = getAgentTools(agent, globalTools, isAdmin);
      return tools.map((t: any) => t.name);
    });
  }

  async function bindOtcclawTools(addTools: string[], memberBlockTools: string[] = []) {
    const { applyAgentToolBinding } = await import('../../../src/llm/agents/tool-binding.js');
    return withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
      applyAgentToolBinding({ agentName: 'otcclaw', addTools, memberBlockTools }),
    );
  }

  function seedTiclawFixture() {
    const tools = [
      'titans_code_sync',
      'titans_code_grep',
      'titans_code_read',
      'titans_code_list',
      'exec_cmd',
      'list_directory',
      'write_file',
      'edit_file',
      'reload_app',
    ];
    const blocked = [
      'exec_cmd',
      'list_directory',
      'write_file',
      'edit_file',
      'reload_app',
    ];
    ctx.db.prepare(`
      INSERT OR IGNORE INTO agents (
        id, name, display_name, description, tools_mode, tools_list,
        user_tools_mode, user_tools_list, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'agent-ticlaw',
      'ticlaw',
      'TIClaw',
      'Test TIClaw fixture',
      'standard',
      JSON.stringify(tools),
      'blocklist',
      JSON.stringify(blocked),
      'admin-001',
    );
    ctx.db.prepare(`
      INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `).run('agent-ticlaw-test-member', 'agent-ticlaw', 'test-user', 'admin');
  }

  describe('standard mode (otcclaw)', () => {
    it('includes COMMON_SET tools', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).toContain('search_knowledge');
      expect(names).toContain('list_todos');
      expect(names).toContain('calculate_date');
      expect(names).toContain('web_search');
    });

    it('includes platform-specific tools from tools_list without work plugin seeds', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).toContain('sandbox_exec');
      expect(names).not.toContain(legacyHedgeMigrationTool);
      expect(names).not.toContain('query_clients');
      expect(names).not.toContain('query_trades');
      expect(names).not.toContain('sync_sbl_data');
      expect(names).not.toContain('analyze_sbl_usage');
      expect(names).not.toContain('query_qfii_latest_valuation_report');
      expect(names).not.toContain('sync_normal_trading_summary');
      expect(names).not.toContain('query_normal_trading_summary');
      expect(names).not.toContain('calc_normal_trading_annual_turnover');
      expect(names).not.toContain('sync_fast_trading_summary');
    });

    it('includes work plugin tools after runtime binding', async () => {
      await bindOtcclawTools([
        'query_clients',
        'query_trades',
        'trade_summary',
        'sync_sbl_data',
        'analyze_sbl_usage',
        'query_qfii_latest_valuation_report',
        'sync_normal_trading_summary',
        'query_normal_trading_summary',
        'calc_normal_trading_annual_turnover',
        'sync_fast_trading_summary',
      ]);

      const names = await getToolNames('otcclaw');
      expect(names).toContain('query_clients');
      expect(names).toContain('query_trades');
      expect(names).toContain('trade_summary');
      expect(names).toContain('sync_sbl_data');
      expect(names).toContain('analyze_sbl_usage');
      expect(names).toContain('query_qfii_latest_valuation_report');
      expect(names).toContain('sync_normal_trading_summary');
      expect(names).toContain('query_normal_trading_summary');
      expect(names).toContain('calc_normal_trading_annual_turnover');
      expect(names).toContain('sync_fast_trading_summary');
    });

    it('respects blockTools', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).not.toContain('generate_video');
    });

    it('excludes AGENT_EXCLUSIVE_TOOLS not owned by this agent', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).not.toContain('record_wrong_question');
      expect(names).not.toContain('list_wrong_questions');
    });

    it('includes UNIVERSAL_TOOLS (http_request)', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).toContain('http_request');
    });
  });

  describe('standard mode (doctor)', () => {
    it('does not include private plugin tools from platform schema', async () => {
      const names = await getToolNames('doctor');
      expect(names).toContain('update_memory');
      expect(names).not.toContain('query_clients');
      expect(names).not.toContain('query_trades');
    });

    it('does not include otcclaw-specific tools', async () => {
      const names = await getToolNames('doctor');
      expect(names).not.toContain('query_clients');
      expect(names).not.toContain('query_trades');
      expect(names).not.toContain('analyze_sbl_usage');
    });
  });

  describe('standard mode (tutor)', () => {
    it('includes wrong-question exclusive tools', async () => {
      const names = await getToolNames('tutor');
      expect(names).toContain('record_wrong_question');
      expect(names).toContain('list_wrong_questions');
      expect(names).toContain('wrong_question_report');
    });
  });

  describe('all mode (alter-ego)', () => {
    it('includes most tools', async () => {
      const names = await getToolNames('alter-ego');
      expect(names).toContain('search_knowledge');
      expect(names).toContain('list_todos');
      expect(names).toContain('sandbox_exec');
    });

    it('does not hardcode work plugin blocks in platform schema', async () => {
      const names = await getToolNames('alter-ego');
      expect(names).toContain('query_clients');
      expect(names).toContain('query_trades');
    });
  });

  describe('MCP agent scope', () => {
    const devtoolsTool = { name: 'mcp_devtools_navigate_page', description: 'devtools', input_schema: { type: 'object', properties: {} } };
    const logyiTool = { name: 'mcp_logyi_search_logs', description: 'logyi', input_schema: { type: 'object', properties: {} } };

    it('exposes scoped MCP tools only to the configured agent in standard mode', async () => {
      seedTiclawFixture();
      setMockMcpTools([devtoolsTool, logyiTool], {
        ticlaw: [devtoolsTool, logyiTool],
        otcclaw: [devtoolsTool],
      });

      const ticlawNames = await getToolNames('ticlaw');
      const otcclawNames = await getToolNames('otcclaw');

      expect(ticlawNames).toContain('mcp_logyi_search_logs');
      expect(otcclawNames).not.toContain('mcp_logyi_search_logs');
    });

    it('toolsMode=all does not bypass MCP agent scope', async () => {
      setMockMcpTools([devtoolsTool, logyiTool], {
        'alter-ego': [devtoolsTool],
      });

      const names = await getToolNames('alter-ego');

      expect(names).toContain('mcp_devtools_navigate_page');
      expect(names).not.toContain('mcp_logyi_search_logs');
    });
  });

  describe('channel filtering', () => {
    it('alter-ego (all mode) on CLI includes agent management tools', async () => {
      const names = await getToolNames('alter-ego', true, 'cli');
      expect(names).toContain('list_agents');
      expect(names).toContain('save_agent');
    });

    it('alter-ego (all mode) on feishu strips CLI-only tools', async () => {
      const names = await getToolNames('alter-ego', true, 'feishu');
      expect(names).not.toContain('list_agents');
      expect(names).not.toContain('save_agent');
      expect(names).not.toContain('delete_agent');
    });

    it('standard mode agent does not get CLI-only tools even on CLI', async () => {
      const names = await getToolNames('otcclaw', true, 'cli');
      expect(names).not.toContain('list_agents');
      expect(names).not.toContain('save_agent');
    });
  });

  describe('user-level filtering (non-admin)', () => {
    it('member cannot use blocklisted write tools', async () => {
      await bindOtcclawTools(
        [
          'add_client',
          'sync_sbl_data',
          'analyze_sbl_usage',
          'query_qfii_latest_valuation_report',
          'sync_normal_trading_summary',
          'query_normal_trading_summary',
          'calc_normal_trading_annual_turnover',
          'sync_fast_trading_summary',
        ],
        ['add_client', 'sync_normal_trading_summary', 'sync_fast_trading_summary'],
      );

      const adminNames = await getToolNames('otcclaw', true);
      const memberNames = await getToolNames('otcclaw', false);

      expect(adminNames).toContain('add_client');
      expect(memberNames).not.toContain('add_client');
      expect(adminNames).toContain('sync_sbl_data');
      expect(memberNames).toContain('sync_sbl_data');
      expect(memberNames).toContain('analyze_sbl_usage');
      expect(memberNames).toContain('query_qfii_latest_valuation_report');
      expect(memberNames).not.toContain(legacyHedgeMigrationTool);
      expect(adminNames).toContain('sync_normal_trading_summary');
      expect(adminNames).toContain('calc_normal_trading_annual_turnover');
      expect(adminNames).toContain('sync_fast_trading_summary');
      expect(memberNames).toContain('query_normal_trading_summary');
      expect(memberNames).toContain('calc_normal_trading_annual_turnover');
      expect(memberNames).not.toContain('sync_normal_trading_summary');
      expect(memberNames).not.toContain('sync_fast_trading_summary');
    });

    it('otcclaw member can calculate normal trading turnover without sync tools', async () => {
      await bindOtcclawTools(
        [
          'sync_normal_trading_summary',
          'query_normal_trading_summary',
          'calc_normal_trading_annual_turnover',
          'sync_fast_trading_summary',
        ],
        ['sync_normal_trading_summary', 'sync_fast_trading_summary'],
      );

      const names = await getToolNames('otcclaw', false);

      expect(names).toContain('calc_normal_trading_annual_turnover');
      expect(names).toContain('query_normal_trading_summary');
      expect(names).not.toContain('sync_normal_trading_summary');
      expect(names).not.toContain('sync_fast_trading_summary');
    });

    it('ticlaw member keeps titans/logyi tools but not high-risk native tools', async () => {
      seedTiclawFixture();
      const logyiTool = { name: 'mcp_logyi_search_logs', description: 'logyi', input_schema: { type: 'object', properties: {} } };
      setMockMcpTools([logyiTool], { ticlaw: [logyiTool] });

      const names = await getToolNames('ticlaw', false);

      expect(names).toContain('titans_code_sync');
      expect(names).toContain('titans_code_grep');
      expect(names).toContain('titans_code_read');
      expect(names).toContain('titans_code_list');
      expect(names).toContain('mcp_logyi_search_logs');
      expect(names).not.toContain('exec_cmd');
      expect(names).not.toContain('list_directory');
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('edit_file');
      expect(names).not.toContain('reload_app');
    });
  });
});
