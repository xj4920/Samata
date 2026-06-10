import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('skill tools', () => {
  useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  describe('saveSkill / getAllSkills / getSkillByName / deleteSkill', () => {
    it('creates and lists skills', async () => {
      const { saveSkill, getAllSkills } = await import('../../../src/commands/skill.js');
      const agentId = await getAgentId('otcclaw');

      const result = await withContext({ agentName: 'otcclaw' }, () =>
        saveSkill('test-skill', '你是一个测试技能', agentId, '测试技能描述'),
      );
      expect(result.success).toBe(true);
      expect((result as any).action).toBe('created');

      const skills = getAllSkills(agentId);
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('test-skill');
    });

    it('updates existing skill', async () => {
      const { saveSkill, getSkillByName } = await import('../../../src/commands/skill.js');
      const agentId = await getAgentId('otcclaw');

      await withContext({ agentName: 'otcclaw' }, () => {
        saveSkill('updatable', '第一版', agentId);
        const updated = saveSkill('updatable', '第二版', agentId);
        expect(updated.success).toBe(true);
        expect((updated as any).action).toBe('updated');
      });

      const skill = getSkillByName('updatable', agentId);
      expect(skill!.prompt).toBe('第二版');
    });

    it('deletes skill', async () => {
      const { saveSkill, deleteSkill, getAllSkills } = await import('../../../src/commands/skill.js');
      const agentId = await getAgentId('standard-test');

      await withContext({ agentName: 'standard-test' }, () => {
        saveSkill('ephemeral', '临时技能', agentId);
        const result = deleteSkill('ephemeral', agentId);
        expect(result.success).toBe(true);
      });

      const skills = getAllSkills(agentId);
      expect(skills.length).toBe(0);
    });

    it('deleting nonexistent skill fails', async () => {
      const { deleteSkill } = await import('../../../src/commands/skill.js');
      const agentId = await getAgentId('standard-test');
      const result = await withContext({ agentName: 'standard-test' }, () =>
        deleteSkill('no-such-skill', agentId),
      );
      expect(result.success).toBe(false);
    });

    it('skills are agent-scoped', async () => {
      const { saveSkill, getAllSkills } = await import('../../../src/commands/skill.js');
      const otcId = await getAgentId('otcclaw');
      const secondAgentId = await getAgentId('standard-test');

      await withContext({ agentName: 'otcclaw' }, () =>
        saveSkill('agent-specific', '仅OTC', otcId),
      );

      expect(getAllSkills(otcId).length).toBe(1);
      expect(getAllSkills(secondAgentId).length).toBe(0);
    });
  });
});
