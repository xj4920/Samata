import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('wiki tools', () => {
  const unit = useUnitDb();

  const createdFiles: string[] = [];

  beforeEach(() => {
    seedTiclawFixture();
  });

  afterEach(() => {
    for (const file of createdFiles.splice(0)) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  });

  function writeWikiPage(agentName: string, page: string, content: string) {
    const filePath = path.join(process.cwd(), 'data', 'wiki', agentName, page);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    createdFiles.push(filePath);
  }

  function seedTiclawFixture() {
    unit.db.prepare(`
      INSERT OR IGNORE INTO agents (
        id, name, display_name, description, tools_mode, tools_list, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'agent-ticlaw',
      'ticlaw',
      'TIClaw',
      'Test TIClaw fixture',
      'standard',
      JSON.stringify(['read_wiki_page', 'file_to_wiki']),
      'admin-001',
    );
  }

  it('reads a wiki page for the current agent', async () => {
    const wikiTools = await import('../../../src/tools/wiki-tools.js');
    const page = 'concepts/__unit_read_wiki_page.md';
    writeWikiPage('ticlaw', page, [
      '---',
      'title: "Unit Wiki Page"',
      'category: concept',
      '---',
      '',
      '# Unit Wiki Page',
      '',
      '这是当前 Agent 的 wiki 内容。',
    ].join('\n'));

    const result = await withContext({ channel: 'cli', role: 'member', agentName: 'ticlaw' }, () =>
      wikiTools.handleTool('read_wiki_page', { page, max_chars: 5000 }),
    );

    const parsed = JSON.parse(result!);
    expect(parsed.error).toBeUndefined();
    expect(parsed.page).toBe(page);
    expect(parsed.title).toBe('Unit Wiki Page');
    expect(parsed.content).toContain('这是当前 Agent 的 wiki 内容。');
  });

  it('rejects parent directory traversal', async () => {
    const wikiTools = await import('../../../src/tools/wiki-tools.js');

    const result = await withContext({ channel: 'cli', role: 'member', agentName: 'ticlaw' }, () =>
      wikiTools.handleTool('read_wiki_page', { page: '../otcclaw/concepts/secret.md' }),
    );

    const parsed = JSON.parse(result!);
    expect(parsed.error).toContain('..');
  });

  it('does not read another agent wiki directory', async () => {
    const wikiTools = await import('../../../src/tools/wiki-tools.js');
    const page = 'concepts/__unit_otc_only.md';
    writeWikiPage('otcclaw', page, [
      '---',
      'title: "OTC Only"',
      'category: concept',
      '---',
      '',
      '只属于 otcclaw 的内容。',
    ].join('\n'));

    const result = await withContext({ channel: 'cli', role: 'member', agentName: 'ticlaw' }, () =>
      wikiTools.handleTool('read_wiki_page', { page }),
    );

    const parsed = JSON.parse(result!);
    expect(parsed.error).toBe(`未找到 wiki 页面: ${page}`);
  });

  it('exposes read_wiki_page to standard agents', async () => {
    const { getAgent, getAgentTools } = await import('../../../src/llm/agents/config.js');
    const { getGlobalTools } = await import('../../../src/llm/agent.js');
    const agent = getAgent('ticlaw');

    const names = await withContext({ channel: 'cli', role: 'member', agentName: 'ticlaw' }, () =>
      getAgentTools(agent, getGlobalTools(), false).map(tool => tool.name),
    );

    expect(names).toContain('search_knowledge');
    expect(names).toContain('read_wiki_page');
  });
});
