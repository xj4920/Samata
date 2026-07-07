---
docModules:
  - platform
docTopics:
  platform: Agent 能力
canonicalDocs:
  - /platform/agent-capability-model
status: planned
---

# OTCCLAW 总经理汇报材料计划

## 背景

下周 EQD 部门领导拟向公司总经理汇报 OTCCLAW 情况，需要准备一份两页 PPT 材料，围绕以下内容展开：

1. OTCCLAW 拟解决的问题。
2. 目前能解决的问题。
3. 当前用户使用情况。
4. 下一步计划。

材料表达上，将第 1、2 点合并为第一页，将第 3、4 点合并为第二页。先制作 HTML 版本用于排版和审阅，再转换为 PPTX。

核心理念：

> 在解决具体业务问题的同时，让知识自主长出来。

当前已根据计划生成 HTML 初稿，PPTX 待后续转换。

## 目标读者与表达原则

- 目标读者：公司总经理及部门管理层。
- 汇报目标：说明 OTCCLAW 为什么做、现在已经能解决什么、真实使用到了什么程度、下一步如何形成部门级能力。
- 表达原则：
  - 不展开系统实现细节，不暴露内部表结构、工具链和代码路径。
  - 少讲"AI 能力"，多讲"业务问题闭环、数据可查、提醒不漏、知识可复用"。
  - 强调 OTCCLAW 不是单次问答工具，而是在每一次查询、问答、提醒和复盘中沉淀部门知识资产。

## 决策

- 材料总页数控制为 2 页，不单独制作封面和目录。
- 第 1 页合并"拟解决的问题"与"目前能解决的问题"，用问题、能力、价值的对应关系表达。
- 第 2 页合并"当前用户使用情况"与"下一步计划"，用真实聚合数据证明使用基础，再给出扩场景、扩用户、建闭环三条推进路径。
- 核心理念采用"在解决具体业务问题的同时，让知识自主长出来"，并贯穿两页材料。
- 统计数据只使用聚合口径，不展示用户明细、客户明细、问题原文和内部系统实现细节。
- 先制作 HTML 版本用于排版确认，再转换为 PPTX，降低直接编辑 PPT 的排版返工成本。

## 初步使用情况分析

统计口径：只读查询 `/opt/samata/data/samata.db` 与相关插件库，agent 为 `agent-otcclaw / 衍语`，时间截至 `2026-07-04`。

### 用户与活跃度

- 累计企微使用：679 个 turn，31 个用户，31 个会话。
- 最近 30 天：232 个 turn，13 个用户。
- 渠道：当前统计全部来自企微，说明主要使用场景已经贴近业务群和工作群。
- 用户分布：
  - 累计前 5 名用户贡献约 71.1% 使用量。
  - 最近 30 天前 5 名用户贡献约 87.1% 使用量。
- 初步判断：OTCCLAW 已形成核心高频用户，但仍处于"小范围高频使用 + 待扩面推广"阶段。

### 使用场景结构

- 累计工具调用：4676 次。
- 平均每轮工具调用：约 6.89 次。
- 工具调用轮次占比：约 82.5%。
- 工具调用失败占比：约 3.7%。

按工具类型聚合：

| 场景 | 调用次数 | 初步解读 |
|------|----------|----------|
| 展业统计分析 | 1921 | 用户已在使用计算、文件生成、图片发送、CSV/图表导出等展业分析能力 |
| 知识/文档检索 | 677 | 知识库问答检索与文档读取仍是基础能力 |
| 交易与业务规模 | 666 | 覆盖极速成交/汇总、常速成交/换手、ETF/T0、套保/SBL |
| 公开信息/网页 | 595 | 存在公开资料搜索、网页读取和外部信息补充需求 |
| 客户管理 | 448 | 覆盖客户状态、客户标签、管理人/交易对手映射 |
| 公司行为提醒 | 142 | 近期新增提醒场景已有实际使用 |

按用户问题关键词粗分，最近 30 天交易/成交/规模类问题约 44.8%，客户/报价/费率约 8.2%，公司行为提醒约 7.3%，知识解释约 6.5%。近期用户重心已明显从单纯知识问答转向业务数据查询与自动提醒。

### 业务数据底座

- OTCCLAW 当前绑定工具数：46 个。
- 普通用户 block 工具数：38 个，说明写入、同步和高风险工具已做权限约束。
- 客户插件库：
  - 136 个客户。
  - 114 个账户/交易对手映射。
  - 341 条客户事件。
  - 状态分布：prod 111、uat 14、initial_contact 10、requirement_discussion 1。
- 知识库：
  - 846 条知识。
  - agent 文档 7 份、23 个 chunk。
- 公司行为提醒库：
  - 覆盖 2026-06-01 至 2026-07-03。
  - 22 个运行日、3757 条事件、30 个源文件。
- ETF 汇总：
  - 覆盖 2026-05-19 至 2026-07-03。
  - 31 个交易日、2 个交易对手。
  - 汇总成交金额约 103.15 亿元。
- 已启用定时任务：
  - ETF 成交预计算。
  - 极速 summary 同步。
  - 北向常速业务规模同步。
  - 每日公司行为提醒同步与推送。

### 使用成熟度判断

- 已验证价值：交易与业务规模查询、客户查询、展业统计分析、公司行为提醒等高频场景已经被真实用户使用。
- 当前短板：
  - 用户覆盖仍偏核心用户，部门级扩面不足。
  - 反馈闭环较弱，显式评价数据较少。
  - 部分数据底座仍处于逐步接入阶段，需要继续扩大场景覆盖。
- 汇报表达建议：向管理层呈现为"已形成可用业务助手雏形，下一步要从工具使用升级为部门知识自增长机制"。

## 两页材料设计

### 第 1 页：拟解决的问题 + 当前能解决的问题

建议标题：

> OTCCLAW：解决业务问题，同时沉淀业务知识

核心设计逻辑：用"问题 -> 当前能力 -> 业务价值"建立管理层视角，避免工具清单式罗列。

拟解决的问题：

- 知识分散：经验散落在群聊、邮件、文档和个人记忆中。
- 重复问答：客户、销售、运营反复问相似问题，核心人员被重复消耗。
- 数据链路长：客户、交易、报价、公司行为等信息分布在不同系统或文件。
- 风险事项依赖人工盯：公司行为、交易数据同步、客户状态推进等场景容易遗漏。
- 经验难复用：一次问题解决后，如果没有沉淀机制，下一次仍要从头查、从头解释。

目前能解决的问题：

- 知识问答：基于 FAQ、文档和历史经验回答衍生品、极速业务、操作规则等问题。
- 客户管理：查询客户状态、客户标签、客户事件、管理人和交易对手映射、报价条款。
- 交易与数据查询：查询极速/常速成交、年化换手、ETF/T0、SBL、Wind 等数据。
- 自动提醒：支撑公司行为提醒、交易数据同步、业务规模同步等定时任务。
- 文件输出：生成 CSV、图片、报表和汇报素材，减少手工整理。
- 知识自增长：通过高频问题、工具调用路径、失败重试经验和复盘机制沉淀可复用知识。

第一页页脚结论：

> 从"人找知识"变成"问题驱动知识生长"。

### 第 2 页：当前用户使用情况 + 下一步计划

建议标题：

> 当前使用情况与下一步计划：从高频使用走向知识自增长

核心设计逻辑：上半页用真实数据证明已被使用，下半页说明如何从核心用户试点推进到部门级工作流。

当前使用情况建议展示：

- 指标卡：
  - 累计触达 18 位业务用户；排除 Feishu ID，名单由用户确认。
  - 最近 30 天 232 个交互 turn。
  - 4676 次工具调用。
- 场景分布：
  - 展业统计分析，并拆分展示计算/脚本、文件生成/写入、图片/文件发送、CSV/图表导出构成。
  - 交易与业务规模。
  - 知识/文档检索。
  - 客户管理。
  - 公司行为提醒。
- 业务资产：
  - 客户、账户映射、客户事件。
  - 知识库和文档。
  - ETF/交易相关汇总。
  - 启用定时任务。

下一步计划建议展示为三条主线：

1. 扩场景
   - 补齐更多交易、报价、持仓、提醒和报表场景。
   - 将已验证的高频查询固化为标准入口，减少人工查数和反复解释。

2. 扩用户
   - 从核心高频用户扩展到销售、运营、IT 支持等更多角色。
   - 梳理标准提问模板、典型场景和培训材料。

3. 建闭环
   - 建立"提问 -> 查询 -> 反馈 -> 复盘 -> 知识沉淀 -> 下次复用"机制。
   - 强化显式评价、失败问题复盘、知识更新、权限审计和运营看板。
   - 把个人经验、工具调用路径、常见问题和失败案例逐步沉淀成部门知识资产。

第二页页脚结论：

> OTCCLAW 的价值，不只是把问题答出来；更重要的是让部门知识在解决问题的过程中持续生长。

## 预期实现路径

1. 新建 HTML 汇报稿
   - 建议路径：`docs/report/2026-07-04_otcclaw_gm_report.html`。
   - 采用 16:9 slide 布局，每页一个 `.slide`。
   - 页面风格采用内部汇报风：清晰标题、少量指标卡、场景分组、克制色彩。

2. HTML 审阅与微调
   - 先在浏览器中预览两页内容。
   - 检查中文换行、字号、边距、重点信息是否适合领导汇报。
   - 确认不出现个人敏感信息、客户明细、内部路径或系统实现细节。

3. 转换 PPTX
   - 建议路径：`docs/report/2026-07-04_otcclaw_gm_report.pptx`。
   - 优先使用 Playwright 渲染 HTML，再用 `pptxgenjs` 或等价本地工具生成 2 页 PPT。
   - 若截图式 PPT 更稳定，使用 HTML 页面截图作为 PPT 背景；若需要可编辑文本，再使用 PPT 原生文本框复刻布局。

4. 结果验证
   - 检查 HTML 可正常打开。
   - 检查 PPTX 文件存在且页数为 2。
   - 导出或截图检查页面没有文本重叠、裁切、字体过小、指标错位。
   - 检查材料只使用聚合统计，不包含用户明细或客户明细。

## 关键技术选择

- HTML 作为源稿：便于快速排版、预览和视觉调整。
- PPTX 作为最终交付格式：满足领导汇报和部门内部流转。
- 聚合统计作为数据依据：只展示汇总指标，不展示个人问题原文、客户样例或内部实现细节。
- 计划文档记录数据口径：后续若运营数据变化，可复跑统计并更新材料。

## 受影响模块与数据流

计划阶段预期涉及文件：

- `docs/plan/2026-07-04_otcclaw-gm-report.md`
  - 记录方案、数据口径、验证命令、commit hash。
- `docs/report/2026-07-04_otcclaw_gm_report.html`
  - 后续新增，作为 PPT 源稿。
- `docs/report/2026-07-04_otcclaw_gm_report.pptx`
  - 后续新增，作为汇报交付件。
- `docs/.vitepress/plan-index.generated.ts`
  - 新增 plan 后由 `npm run docs:plan-sync` 自动同步。

数据流：

```text
部署库聚合统计
  -> 提炼管理层可读指标
  -> HTML 两页汇报稿
  -> PPTX 两页交付稿
  -> 汇报后反馈
  -> 更新计划文档与材料版本
```

本计划不会修改 Samata 应用运行时 memory 数据库，也不会把长期编码规则写入 `data/samata.db`。

## 改动清单

计划写入阶段：

- 新增 `docs/plan/2026-07-04_otcclaw-gm-report.md`
  - 记录汇报背景、核心理念、两页材料结构、使用情况分析、实现路径、技术选择、验证命令和构建影响。
- 更新 `docs/.vitepress/plan-index.generated.ts`
  - 由 `npm run docs:plan-sync` 自动生成，将新增 plan 纳入文档索引。

后续材料生成阶段：

- 已新增 `docs/report/2026-07-04_otcclaw_gm_report.html`。
  - 已根据预览反馈调整第一页：移除右上角日期小字、左右条目分类色块垂直居中、放大"核心理念"、右侧内容划分居中。
  - 已根据二次预览反馈调整第一页：将"问题驱动知识生长"改为单行展示。
  - 已根据三次预览反馈调整第一页：将"核心理念"和"问题驱动知识生长"的字体规格改为与"拟解决的问题"一致。
  - 已根据四次预览反馈调整第一页：将"核心理念"改为绿色竖条 + 黑色粗体标题样式，并在中间卡片左上角对齐。
  - 已根据第二页预览反馈调整使用情况：移除 679 turn 指标卡，拆分展业统计分析构成，移除 3757 公司行为事件资产卡并替换为 4 项启用定时任务。
  - 已根据用户确认名单调整第二页：用户指标改为 18 位业务用户，去掉技术 user_id 小字；展业统计分析拆为 1127 计算/脚本、400 文件生成/写入、236 图片/文件发送、91 CSV/图表导出，并补充文件查看/读取 57、知识沉淀 10。
  - 已根据口径确认调整第二页：`知识文档` 改为 `知识/文档检索`，`交易查询` 改为 `交易与业务规模 666`，并补充交易构成。
  - 已根据预览反馈调整第二页：为拆解说明增加指向前缀，明确交易构成属于`交易与业务规模`，补充项属于`展业统计分析`。
  - 已根据最新预览反馈调整第二页：去掉`4 项`、`31 天`单位；将`18`、`232`、`4,676`三张指标卡缩窄并居中；将展业统计分析拆分数字改为四色区分；拆解说明顺序调整为先`展业统计分析`、再`交易与业务规模`，与直方图顺序一致。
  - 已根据最新口径反馈调整第二页：在`客户基础数据`、`知识条目`、`启用定时任务`、`ETF 汇总覆盖`四个卡片前增加`基础数据与自动化覆盖`说明，明确这些指标为独立统计，不属于上方分类拆解。
  - 已根据预览反馈调整第一页标签：`分散`、`重复`、`割裂`、`遗漏`、`问答`、`客户`、`交易`、`提醒`改为中间带空格的视觉标签，并将第一页三栏区域高度从 382px 调整为 390px，避免标签变化后右侧面板拥挤。
  - 已根据标题口径反馈调整第二页主标题：由`从高频使用走向知识自增长`改为`已切入实际工作，下一步闭环答案质量`；引导语调整为“当前已基本满足日常查询与分析需求，下一阶段基于用户反馈优化答案组织，形成问答质量闭环”。
  - 已根据预览反馈调整第二页基础数据数字配色：`136`为蓝色、`846`为绿色、`4`为紫色、`31`为金色，增强四个独立统计卡片的可读性。
  - 已根据预览反馈调整第一页底部三块说明：将`.value-strip`列宽和间距改为与`.page-one-grid`一致，使底部说明块与上方三栏左右边界对齐。
- 计划新增 `docs/report/2026-07-04_otcclaw_gm_report.pptx`。
- 已生成浏览器预览截图：
  - `docs/report/2026-07-04_otcclaw_gm_report_slide1.png`
  - `docs/report/2026-07-04_otcclaw_gm_report_slide2.png`

## 验证命令

计划文档写入阶段：

```text
npm run docs:plan-sync
git diff --check -- docs/.vitepress/plan-index.generated.ts
node - <<'NODE'
const fs = require('node:fs');
const file = 'docs/plan/2026-07-04_otcclaw-gm-report.md';
const lines = fs.readFileSync(file, 'utf8').split('\n');
const bad = lines.flatMap((line, index) => /[ \t]$/.test(line) ? [`${file}:${index + 1}: trailing whitespace`] : []);
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
NODE
```

HTML/PPT 生成阶段：

```text
test -f docs/report/2026-07-04_otcclaw_gm_report.html
test -f docs/report/2026-07-04_otcclaw_gm_report.pptx
```

如后续新增 PPT 检查脚本，可补充页数验证命令，确保输出严格为 2 页。

## 验证结果

已执行：

```text
npm run docs:plan-sync
# 第一次执行 updated docs/.vitepress/plan-index.generated.ts
# 第二次执行 docs/.vitepress/plan-index.generated.ts is up to date
# 脚本输出了历史 plan frontmatter 既有 warning/error，本次新增 plan 未被点名；命令退出码为 0。

git diff --check -- docs/.vitepress/plan-index.generated.ts
# passed

node - <<'NODE'
const fs = require('node:fs');
const file = 'docs/plan/2026-07-04_otcclaw-gm-report.md';
const lines = fs.readFileSync(file, 'utf8').split('\n');
const bad = lines.flatMap((line, index) => /[ \t]$/.test(line) ? [`${file}:${index + 1}: trailing whitespace`] : []);
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
NODE
# docs/plan/2026-07-04_otcclaw-gm-report.md: no trailing whitespace

test -f docs/report/2026-07-04_otcclaw_gm_report.html
# ok

git check-ignore -v docs/report/2026-07-04_otcclaw_gm_report.html
# .gitignore:52:docs/report/ docs/report/2026-07-04_otcclaw_gm_report.html

node - <<'NODE'
const fs = require('node:fs');
const file = 'docs/report/2026-07-04_otcclaw_gm_report.html';
const html = fs.readFileSync(file, 'utf8');
const lines = html.split('\n');
const bad = lines.flatMap((line, index) => /[ \t]$/.test(line) ? [`${file}:${index + 1}: trailing whitespace`] : []);
const slides = [...html.matchAll(/<section class="slide"/g)].length;
const oldPath = html.includes('docs/reports/');
const hasConcept = html.includes('在解决具体业务问题的同时，让知识自主长出来。');
console.log(JSON.stringify({ slides, oldPath, hasConcept, trailingWhitespace: bad.length }, null, 2));
if (bad.length || slides !== 2 || oldPath || !hasConcept) process.exit(1);
NODE
# {"slides":2,"oldPath":false,"hasConcept":true,"trailingWhitespace":0}

node - <<'NODE'
const path = require('node:path');
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`file://${path.resolve('docs/report/2026-07-04_otcclaw_gm_report.html')}`, { waitUntil: 'networkidle0' });
  const info = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((slide, index) => {
    const rect = slide.getBoundingClientRect();
    const overflowing = [...slide.querySelectorAll('*')].filter((node) => {
      const r = node.getBoundingClientRect();
      return r.right > rect.right + 1 || r.bottom > rect.bottom + 1 || r.left < rect.left - 1 || r.top < rect.top - 1;
    }).length;
    return { index: index + 1, width: Math.round(rect.width), height: Math.round(rect.height), overflowing };
  }));
  await browser.close();
  console.log(JSON.stringify({ info, errors }, null, 2));
  if (errors.length || info.length !== 2 || info.some(s => s.overflowing > 0)) process.exit(1);
})();
NODE
# {"info":[{"index":1,"width":1384,"height":779,"overflowing":0},{"index":2,"width":1384,"height":779,"overflowing":0}],"errors":[]}

Puppeteer 复检预览反馈调整
# firstDateText="", coreFont="18px", slide overflowing=0, errors=[]

Puppeteer 复检二次预览反馈调整
# titleText="问题驱动知识生长", titleWhiteSpace="nowrap", slide overflowing=0, errors=[]

Puppeteer 复检三次预览反馈调整
# panelTitle/fontSize="18px", growthLabel/fontSize="18px", growthTitle/fontSize="18px", fontWeight="800", slide overflowing=0, errors=[]

Puppeteer 复检四次预览反馈调整
# growthHeading 使用 panel-title + title-bar；coreTextAlign="left"; headingOffset={left:15,top:13}; slide overflowing=0, errors=[]

Puppeteer 复检第二页使用情况调整
# has679=false, has3757=false, hasReportFile=false, hasUsers=true, hasBreakdown=true, hasScheduled=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第二页确认名单与拆解口径调整
# has18Users=true, has19Plus=false, hasUserIdNote=false, hasBreakdown=true, hasRemainder=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第二页拆解说明指向调整
# hasTradePrefix=true, hasAnalysisPrefix=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第二页最新版式调整
# noRemovedUnits=true, metricCentered=true, metricWidth=268, distinctBreakdownColors=true, orderOk=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第二页基础数据说明调整
# hasAssetNote=true, assetNoteBeforeGrid=true, gridToFoot=4.8, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第一页标签与第二页标题调整
# tagTexts=["分 散","重 复","割 裂","遗 漏","问 答","客 户","交 易","提 醒"], oldTagTextsAbsent=true, hasNewTitle=true, hasQualityLead=true, removedOldTitle=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第二页基础数据数字配色
# assetValues=[136:blue,846:green,4:violet,31:gold], distinctAssetColors=true, slide overflowing=0, panel overflowing=0, errors=[]

Puppeteer 复检第一页底部说明块对齐
# valueStripAligned=true, columns=[425.7,374.6,425.7], gaps=24, slide overflowing=0, panel overflowing=0, errors=[]
```

## Commit Hash

- 3653c8b

## 构建与运行影响

- 计划写入阶段仅新增文档与同步文档索引，不影响运行时构建产物、Docker image、插件构建产物、依赖或数据库 migration。
- 后续生成 HTML/PPT 也属于文档交付物，不需要重新构建 Samata Docker image。
