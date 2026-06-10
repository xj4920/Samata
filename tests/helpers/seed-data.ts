import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

/**
 * Insert test seed data into the in-memory DB.
 * Called after initSchema() so all tables already exist.
 */
export function seedTestData(db: Database.Database) {
  seedTestAgents(db);
  seedClients(db);
  seedTodos(db);
}

export function seedTestAgents(db: Database.Database) {
  const insAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, display_name, description, tools_mode, tools_list,
      block_tools, preset, user_tools_mode, user_tools_list, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMember = db.prepare(`
    INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role)
    VALUES (?, ?, ?, ?)
  `);

  const fixtures = [
    {
      id: 'agent-doctor',
      name: 'doctor',
      displayName: '家庭医生',
      description: 'Test standard assistant fixture',
      toolsMode: 'standard',
      toolsList: ['update_memory'],
      blockTools: [],
      preset: null,
      userToolsMode: 'inherit',
      userToolsList: [],
    },
    {
      id: 'agent-tutor',
      name: 'tutor',
      displayName: '教育辅导',
      description: 'Test tutor fixture',
      toolsMode: 'standard',
      toolsList: [
        'record_wrong_question',
        'list_wrong_questions',
        'mark_wrong_question_mastered',
        'wrong_question_report',
      ],
      blockTools: [],
      preset: null,
      userToolsMode: 'inherit',
      userToolsList: [],
    },
    {
      id: 'agent-alter-ego',
      name: 'alter-ego',
      displayName: '个人分身',
      description: 'Test personal assistant fixture',
      toolsMode: 'all',
      toolsList: [],
      blockTools: [],
      preset: null,
      userToolsMode: 'inherit',
      userToolsList: [],
    },
  ];

  for (const agent of fixtures) {
    insAgent.run(
      agent.id,
      agent.name,
      agent.displayName,
      agent.description,
      agent.toolsMode,
      agent.toolsList.length > 0 ? JSON.stringify(agent.toolsList) : null,
      agent.blockTools.length > 0 ? JSON.stringify(agent.blockTools) : null,
      agent.preset,
      agent.userToolsMode,
      agent.userToolsList.length > 0 ? JSON.stringify(agent.userToolsList) : null,
      'admin-001',
    );
    insMember.run(`test-${agent.id}-admin`, agent.id, 'admin-001', 'admin');
  }
}

function seedClients(db: Database.Database) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO clients (id, name, contact, state, wework_group, requirements, tags, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin-001')
  `);
  ins.run('client-kuande', '宽德', '张三', 'prod', '宽德-广发对接群', '北上极速通道', '["北上","极速"]', '活跃客户');
  ins.run('client-jump', 'Jump', 'John', 'uat', 'Jump&GF系统连接群', 'FIX 接入', '["FIX","极速"]', 'UAT 测试中');
  ins.run('client-jinde', 'Jinde', '李四', 'prod', 'Jinde-广发股衍香港IT对接', 'OTC 衍生品', '["OTC"]', null);
}

function seedTodos(db: Database.Database) {
  const agentId = db.prepare("SELECT id FROM agents WHERE name='alter-ego'").get() as { id: string } | undefined;
  if (!agentId) return;

  const ins = db.prepare(`
    INSERT INTO todos (id, agent_id, user_id, title, description, status, priority, due_date)
    VALUES (?, ?, 'admin-001', ?, ?, ?, ?, ?)
  `);
  const aid = agentId.id;
  ins.run(uuid(), aid, '完成季度报告', '整理Q2交易数据', 'pending', 'high', '2026-05-30');
  ins.run(uuid(), aid, '预约体检', '年度体检预约', 'pending', 'normal', '2026-06-15');
  ins.run(uuid(), aid, '阅读《系统设计》', '第3-5章', 'in_progress', 'low', null);
}
