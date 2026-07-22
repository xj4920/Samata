import { defineConfig } from 'vitepress';
import type { DefaultTheme } from 'vitepress';
import { planIndexByModule } from './plan-index.generated';
import type { DocModule, PlanIndexItem } from './plan-index.generated';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const addVPre = (html: string, tag: 'code' | 'pre') => {
  return html.includes(`<${tag} v-pre`) ? html : html.replace(`<${tag}`, `<${tag} v-pre`);
};


const groupPlanItems = (module: DocModule) => {
  const groups = planIndexByModule[module].reduce<Record<string, PlanIndexItem[]>>((acc, item) => {
    acc[item.topic] ??= [];
    acc[item.topic].push(item);
    return acc;
  }, {});

  return Object.entries(groups)
    .sort(([topicA], [topicB]) => topicA.localeCompare(topicB, 'zh-CN'))
    .map(([topic, items]) => ({
      text: topic,
      collapsed: true,
      items: items.map((item) => ({
        text: item.date ? `${item.date} ${item.title}` : item.title,
        link: item.link,
      })),
    }));
};

const moduleSidebar = (module: DocModule, formalItems: DefaultTheme.SidebarItem[]) => [
  {
    text: '正式文档',
    items: formalItems,
  },
  {
    text: '相关设计/演进记录',
    collapsed: true,
    items: groupPlanItems(module),
  },
];

const platformSidebar = moduleSidebar('platform', [
  { text: '平台介绍', link: '/platform/' },
  { text: '平台架构', link: '/platform/architecture' },
  { text: 'Agent 能力模型', link: '/platform/agent-capability-model' },
  { text: '渠道与会话', link: '/platform/channels-and-sessions' },
  { text: '通用工具', link: '/platform/common-tools' },
  { text: '部署与模型', link: '/platform/deployment' },
  { text: '观测与稳定性', link: '/platform/observability' },
]);

const permissionsSidebar = moduleSidebar('permissions', [
  { text: '权限控制', link: '/permissions/' },
  { text: '角色与 RBAC', link: '/permissions/roles-and-rbac' },
  { text: '渠道隔离', link: '/permissions/channel-isolation' },
  { text: '工具可见性', link: '/permissions/tool-access' },
  { text: '资源作用域', link: '/permissions/resource-scopes' },
  { text: '文件与沙箱白名单', link: '/permissions/file-and-sandbox-allowlist' },
]);

const dreamSidebar = moduleSidebar('dream', [
  { text: 'Dream', link: '/dream/' },
  { text: 'Dream 机制', link: '/dream/mechanism' },
  { text: '质量与观测', link: '/dream/quality' },
]);

const pluginsSidebar = moduleSidebar('plugins', [
  { text: '插件机制', link: '/plugins/' },
  { text: 'Plugin SDK 与生命周期', link: '/plugins/sdk-and-lifecycle' },
  { text: '加载与热更新', link: '/plugins/loading-and-hot-reload' },
  { text: '绑定 Agent', link: '/plugins/bind-to-agent' },
  { text: '插件目录', link: '/plugins/catalog' },
]);

const externalDataSidebar = moduleSidebar('external-data', [
  { text: '外部数据', link: '/external-data/' },
  { text: '报价与交易', link: '/external-data/pricing-and-trade' },
  { text: 'Wiki 与文档源', link: '/external-data/wiki-and-doc-sources' },
  { text: 'Web 与浏览器', link: '/external-data/web-and-browser' },
]);

const traceSidebar = [
  {
    text: '演进记录说明',
    items: [
      { text: '说明', link: '/plan/' },
    ],
  },
  {
    text: '按模块追溯',
    items: [
      { text: '平台介绍', link: '/platform/' },
      { text: '权限控制', link: '/permissions/' },
      { text: 'Dream', link: '/dream/' },
      { text: '插件机制', link: '/plugins/' },
      { text: '外部数据', link: '/external-data/' },
    ],
  },
];

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
      { text: '平台介绍', link: '/platform/' },
      { text: '权限控制', link: '/permissions/' },
      { text: 'Dream', link: '/dream/' },
      { text: '插件机制', link: '/plugins/' },
      { text: '外部数据', link: '/external-data/' },
    ],
    sidebar: {
      '/platform/': platformSidebar,
      '/permissions/': permissionsSidebar,
      '/dream/': dreamSidebar,
      '/plugins/': pluginsSidebar,
      '/external-data/': externalDataSidebar,
      '/plan/': traceSidebar,
    },
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
