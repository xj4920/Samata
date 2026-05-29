import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, withContext, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('getAgentTools', () => {
  let ctx: UnitTestContext;

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

  describe('standard mode (otcclaw)', () => {
    it('includes COMMON_SET tools', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).toContain('search_knowledge');
      expect(names).toContain('list_todos');
      expect(names).toContain('calculate_date');
      expect(names).toContain('web_search');
    });

    it('includes agent-specific tools from tools_list', async () => {
      const names = await getToolNames('otcclaw');
      expect(names).toContain('query_clients');
      expect(names).toContain('query_trades');
      expect(names).toContain('trade_summary');
      expect(names).toContain('sandbox_exec');
      expect(names).toContain('sync_sbl_data');
      expect(names).toContain('analyze_sbl_usage');
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
    it('includes health tools from tools_list', async () => {
      const names = await getToolNames('doctor');
      expect(names).toContain('query_health_records');
      expect(names).toContain('health_summary');
      expect(names).toContain('log_sleep');
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

    it('respects blockTools — excludes client/trade/health tools', async () => {
      const names = await getToolNames('alter-ego');
      expect(names).not.toContain('query_clients');
      expect(names).not.toContain('query_trades');
      expect(names).not.toContain('query_health_records');
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
      const adminNames = await getToolNames('otcclaw', true);
      const memberNames = await getToolNames('otcclaw', false);

      expect(adminNames).toContain('add_client');
      expect(memberNames).not.toContain('add_client');
      expect(adminNames).toContain('sync_sbl_data');
      expect(memberNames).toContain('sync_sbl_data');
      expect(memberNames).toContain('analyze_sbl_usage');
    });
  });
});
