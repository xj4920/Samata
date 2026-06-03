import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import type { DefaultTheme } from 'vitepress';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planDir = resolve(docsRoot, 'plan');

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const addVPre = (html: string, tag: 'code' | 'pre') => {
  return html.includes(`<${tag} v-pre`) ? html : html.replace(`<${tag}`, `<${tag} v-pre`);
};

const formatFallbackTitle = (fileName: string) => {
  return basename(fileName, '.md')
    .replace(/\.plan$/, '')
    .replace(/^\d{4}-\d{2}-\d{2}_/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
};

const readMarkdownTitle = (filePath: string, fileName: string) => {
  const content = readFileSync(filePath, 'utf8');
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return title || formatFallbackTitle(fileName);
};

const getPlanMonth = (fileName: string) => {
  const match = fileName.match(/^(\d{4})-(\d{2})-\d{2}_/);
  return match ? `${match[1]}-${match[2]}` : '未归档';
};

const planPages = existsSync(planDir)
  ? readdirSync(planDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md')
      .map((entry) => {
        const fileName = entry.name;
        const slug = basename(fileName, '.md');
        return {
          month: getPlanMonth(fileName),
          sortKey: fileName,
          text: readMarkdownTitle(resolve(planDir, fileName), fileName),
          link: `/plan/${slug}`,
        };
      })
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  : [];

const planSidebarItems = Object.entries(
  planPages.reduce<Record<string, DefaultTheme.SidebarItem[]>>((groups, page) => {
    groups[page.month] ??= [];
    groups[page.month].push({
      text: page.text,
      link: page.link,
    });
    return groups;
  }, {}),
)
  .sort(([monthA], [monthB]) => monthB.localeCompare(monthA))
  .map(([month, items]) => ({
    text: month,
    collapsed: true,
    items,
  }));

const windTablePages = [
  'AINDEXEODPRICES',
  'ASHAREBALANCESHEET',
  'ASHARECALENDAR',
  'ASHARECASHFLOW',
  'ASHARECONSENSUSDATA',
  'ASHAREDIVIDEND',
  'ASHAREEODDERIVATIVEINDICATOR',
  'ASHAREEODPRICES',
  'ASHAREINCOME',
  'ASHAREINDUSTRIESCODE',
  'ASHAREINTRODUCTION',
  'ASHAREISACTIVITY',
  'ASHAREST',
  'ASHARESTOCKRATINGCONSUS',
  'ASHARETRADINGSUSPENSION',
  'CFUTURESCONTRACTMAPPING',
  'CFUTURESDESCRIPTION',
  'CHINAMUTUALFUNDDESCRIPTION',
  'CHINAMUTUALFUNDMANAGER',
  'CHINAMUTUALFUNDSECTOR',
  'CHINAMUTUALFUNDSTOCKPORTFOLIO',
  'CINDEXFUTURESEODPRICES',
  'SHSCCHANNELHOLDINGS',
  'SHSCTOP10ACTIVESTOCKS',
].map((name) => ({
  text: name,
  link: `/wind-tables/${name}`,
}));

export default defineConfig({
  title: 'Samata',
  description: 'Samata 多 Agent 智能助手平台文档',
  lang: 'zh-CN',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    config(md) {
      const renderFence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const rendered = renderFence
          ? renderFence(tokens, idx, options, env, self)
          : `<pre><code>${escapeHtml(tokens[idx].content)}</code></pre>\n`;
        return addVPre(rendered, 'pre');
      };

      const renderCodeInline = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const rendered = renderCodeInline
          ? renderCodeInline(tokens, idx, options, env, self)
          : `<code>${escapeHtml(tokens[idx].content)}</code>`;
        return addVPre(rendered, 'code');
      };
    },
  },
  themeConfig: {
    siteTitle: 'Samata Docs',
    search: {
      provider: 'local',
    },
    nav: [
      { text: '平台机制', link: '/agent-skills-tools-knowledge-memory-overview' },
      { text: '权限', link: '/permission-system' },
      { text: 'Dream', link: '/dream-mechanism' },
      { text: '计划归档', link: '/plan/' },
      { text: 'Wind 数据', link: '/wind-tables-schema' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '文档首页', link: '/' },
        ],
      },
      {
        text: '平台机制',
        items: [
          { text: 'Agent / Skill / Tool / Knowledge / Memory', link: '/agent-skills-tools-knowledge-memory-overview' },
          { text: '权限管理机制', link: '/permission-system' },
          { text: 'Dream 机制', link: '/dream-mechanism' },
        ],
      },
      {
        text: 'Wind 数据',
        items: [
          { text: 'Wind 数据库', link: '/wind-database' },
          { text: 'Oracle Wind 数据库', link: '/oracle-wind-database' },
          { text: 'Wind 表结构索引', link: '/wind-tables-schema' },
        ],
      },
      {
        text: '计划归档',
        collapsed: true,
        items: [
          { text: '归档首页', link: '/plan/' },
          ...planSidebarItems,
        ],
      },
      {
        text: 'Wind 表明细',
        collapsed: true,
        items: windTablePages,
      },
    ],
    outline: {
      label: '本页目录',
      level: [2, 3],
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },
    darkModeSwitchLabel: '主题',
    lastUpdatedText: '最后更新',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
  },
});
