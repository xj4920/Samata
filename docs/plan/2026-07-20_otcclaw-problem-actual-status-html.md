# OTCCLAW “拟解决的问题与目前实际情况”单页材料

## 背景

2026-07-20 根据既有 OTCCLAW 两页汇报材料和用户提供的三张局部截图，重新生成一份单页 HTML。新材料只聚焦两块内容：

1. 拟解决的问题；
2. 目前实际情况。

原始两页材料 `docs/report/2026-07-04_otcclaw_gm_report.html` 保留不变，新稿作为独立文件生成。

## 核心决策

- 采用单页 16:9、1440 × 810 汇报画布，页面可直接在浏览器中预览，也可通过打印样式输出为图片或 PDF。
- 页面使用纯 HTML/CSS 实现，不加载外部字体、脚本或 CDN 资源，避免离线预览时样式缺失。
- 页面颜色使用用户提供的 PowerPoint “Recent Colors” 色卡：
  - 深蓝：`#004589`、`#004892`；
  - 浅蓝：`#bfd5f5`；
  - 米色：`#b49c7e`、`#ddd3c5`、`#d2c4b2`、`#bfaa91`；
  - 奶油色与中性色：`#fff1dd`、`#f5f3ef`、`#e4e4e4`。
- 页面顶部不再渲染 OTCCLAW 标识、材料副标题、统计日期或分隔线，保留 36px 纯空白区域，供外部 PPT 模板表头占用；画布不绘制外边框。
- 内容采用左窄右宽两栏布局：
  - 左栏展示“分散、重复、未用、遗漏”四类问题，以及“从人找知识到知识主动复用”的结论；
  - 右栏展示三项核心指标、五类使用场景、展业统计拆解、交易与业务规模构成，以及基础数据与自动化覆盖。
- 数据和文字沿用附件及 2026-07-04 版本中的聚合口径，不引入新的运行时数据查询。
- 删除旧稿中“核心理念”“目前能解决的问题”“下一步计划”等不属于本次范围的内容。

## 数据与页面流

```text
附件截图与既有 HTML 聚合口径
  ├─ 问题描述
  │   └─ 四类问题卡片 + 知识主动复用结论
  └─ 使用数据
      ├─ 3 项核心指标
      ├─ 5 类使用场景
      ├─ 展业统计与交易构成
      └─ 4 项基础数据及自动化覆盖
          ↓
单页自包含 HTML
          ↓
Puppeteer 1440 × 810 渲染与截图复检
```

## 改动清单

- 新增 `docs/report/2026-07-20_otcclaw_problem_actual_status.html`
  - 新增单页 OTCCLAW 汇报画布；
  - 复刻附件的问题卡、指标卡、使用场景条形图和数据拆解；
  - 按附件 Recent Colors 色卡调整主色、辅助色、面板底色和图表颜色；
  - 清空页面表头内容，仅保留 PPT 模板所需的空白占位区；
  - 收窄表头预留区与主标题之间的视觉间距，并移除画布外边框；
  - 将第三项问题从“割裂 / 业务数据链路长”调整为“未用 / 业务数据价值未充分释放”，突出既有客户、交易、报价、公司行为等数据尚未充分转化为展业支持和客户行为刻画能力；
  - 增加响应式浏览与 16:9 打印样式。
- 新增 `docs/plan/2026-07-20_otcclaw-problem-actual-status-html.md`
  - 记录背景、设计决策、改动范围、验证方式、构建影响和提交信息。

## 验证命令

```bash
test -f docs/report/2026-07-20_otcclaw_problem_actual_status.html

node -e "const fs=require('fs');const s=fs.readFileSync('docs/report/2026-07-20_otcclaw_problem_actual_status.html','utf8');const required=['未 用','业务数据价值未充分释放','客户、交易、报价、公司行为等数据已沉淀在系统中，尚未充分转化为展业支持和客户行为刻画能力。'];const removed=['割 裂','业务数据链路长','客户、交易、报价、公司行为信息分布在不同系统或文件。'];for(const text of required){if(!s.includes(text))throw new Error('缺少新文案: '+text)}for(const text of removed){if(s.includes(text))throw new Error('仍存在旧文案: '+text)}"

node --input-type=module <<'NODE'
import puppeteer from 'puppeteer';
import path from 'node:path';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1496, height: 866, deviceScaleFactor: 1 });
await page.goto(
  `file://${path.resolve('docs/report/2026-07-20_otcclaw_problem_actual_status.html')}`,
  { waitUntil: 'networkidle0' },
);
const result = await page.evaluate(() => {
  const slide = document.querySelector('.slide');
  const slideInner = document.querySelector('.slide-inner');
  return {
    slides: document.querySelectorAll('.slide').length,
    title: document.title,
    slideWidth: slide?.getBoundingClientRect().width,
    slideHeight: slide?.getBoundingClientRect().height,
    overflowX: slideInner ? slideInner.scrollWidth > slideInner.clientWidth : null,
    overflowY: slideInner ? slideInner.scrollHeight > slideInner.clientHeight : null,
    text: document.body.innerText,
  };
});
console.log(JSON.stringify(result, null, 2));
const slide = await page.$('.slide');
await slide.screenshot({
  path: '/tmp/2026-07-20_otcclaw_problem_actual_status.png',
});
await browser.close();
NODE

node -e "const fs=require('fs');for(const p of ['docs/report/2026-07-20_otcclaw_problem_actual_status.html','docs/plan/2026-07-20_otcclaw-problem-actual-status-html.md']){const lines=fs.readFileSync(p,'utf8').split(/\n/);const bad=[];lines.forEach((line,i)=>{if(/[ \t]+$/.test(line))bad.push(i+1)});if(bad.length)throw new Error(p+' 存在行尾空白: '+bad.join(','));}"
```

## 验证结果

- `test -f docs/report/2026-07-20_otcclaw_problem_actual_status.html`：通过。
- Puppeteer 以 1496 × 866 浏览器视口渲染，页面中的汇报画布为精确的 1440 × 810：
  - `.slide` 数量为 1；
  - `slideWidth = 1440`、`slideHeight = 810`；
  - `.slide-inner` 横向、纵向均无溢出；
  - 所有必需标题、问题描述、核心指标和使用场景文字均存在；
  - 页面元素均未超出汇报画布边界。
- 第三项问题文案修订专项检查：
  - 新文案“未用 / 业务数据价值未充分释放”及完整说明均已写入；
  - 旧文案“割裂 / 业务数据链路长”及“分布在不同系统或文件”均已从本页移除；
  - 第三张问题卡横向、纵向均无溢出，且完整位于汇报画布内。
- Recent Colors 与表头专项检查：
  - 十个附件色值均已进入页面样式；
  - 旧版绿色、红色、金色、紫色色彩变量已不再使用；
  - 表头占位区高度为 36px，子元素数量为 0、文字为空；
  - 页面中不存在旧版 `.brand`、`.mark` 或 `.date` 表头元素。
  - 主标题顶部距画布顶部 84px；
  - 画布边框计算值为 `0px / none`。
- 已生成并人工复检预览截图：
  `/home/xj/.codex/visualizations/2026/07/20/019f7e00-45f8-7cd1-840f-2a5974187a26/otcclaw_problem_actual_status_compact_header.png`。
- 已生成并人工复检文案修订后的预览截图：
  `/home/xj/.codex/visualizations/2026/07/20/019f7e83-abac-7760-bb85-ae00aae65ef3/otcclaw_problem_actual_status_copy_revision.png`。
- HTML 与计划文档行尾空白检查：通过。

## 构建与运行影响

- 本次不修改 Samata 运行时代码、插件、依赖或数据库结构。
- 不影响 Docker image 或其他构建产物，无需重新构建镜像或重启服务。
- `docs/report/` 已被 Git 忽略，HTML 为本地汇报产物；计划文档按仓库规范进入 Git 留档。

## 提交信息

- Commit hash：待用户确认提交后补充。
- Push 状态：待用户确认提交后补充。
