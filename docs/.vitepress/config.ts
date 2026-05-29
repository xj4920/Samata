import { defineConfig } from 'vitepress';

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
  themeConfig: {
    siteTitle: 'Samata Docs',
    search: {
      provider: 'local',
    },
    nav: [
      { text: '平台机制', link: '/agent-skills-tools-knowledge-memory-overview' },
      { text: '权限', link: '/permission-system' },
      { text: 'Dream', link: '/dream-mechanism' },
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
