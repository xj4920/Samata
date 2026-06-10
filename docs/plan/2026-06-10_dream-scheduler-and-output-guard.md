---
docModules:
  - dream
docTopics:
  dream: 质量与观测
canonicalDocs:
  - /dream/quality
status: implemented
---

# Dream 内置调度与输出质量保护

## 背景

Dream 在 2026-05 已从“工具调用统计日报”改为“基于工具回放提炼长期经验”。该方向仍然有效，但运行中暴露两个问题：

1. 宿主机 crontab 直接执行本地 `npx tsx scripts/dream.ts`，与 Docker 内 Samata 运行环境不一致。近期 `logs/app-YYYY-MM-DD.log` 由容器 root 写入，宿主机用户追加日志失败，导致 Dream 自 2026-06-04 起连续失败。
2. 2026-06-03 生成的 otcclaw/ticlaw dream 文件为半截内容，但原校验只检查标题、分节和禁用词，未阻止截断输出覆盖上一版有效经验。

Code issue: https://code.gf.com.cn/gf/_code/gf/gzxujun/samata/-/issues/21

## 决策

- Dream 定时调度内置到 Samata server 生命周期中，只在服务模式启动，不再依赖宿主机直接跑本地 Node。
- 不在 Dockerfile 内安装系统 cron，避免一个容器同时管理 app 与 crond 两套进程。
- `loadDreamFile()` 读取“最新有效 dream”，遇到半截或无效文件自动回退到上一份有效文件。
- 新 dream 写入前对照历史版本做退化校验，异常缩水、结构不完整或疑似截断时跳过写入。
- logger 文件写入失败时降级，不允许日志权限问题中断 Dream 或其他业务流程。

## 改动清单

- `src/services/dream-scheduler.ts`
  - 新增 Dream 内置调度器，默认 cron 为 `0 3 * * *`，时区为 `Asia/Chongqing`。
  - 新增本地锁 `data/dreams/.dream-scheduler.lock`，防止重复执行。
- `src/index.ts`
  - server 模式启动 Dream scheduler，优雅关闭时停止。
- `src/services/dream-analyze.ts`
  - `loadDreamFile()` 改为跳过无效文件并回退到上一份有效 dream。
  - `validateDream()` 增强结构、截断和异常缩水校验。
- `src/utils/logger.ts`
  - 日志文件不可写时降级为终端告警，不再抛出异常。
- `tests/unit/services/dream-analyze.test.ts`
  - 覆盖半截最新 dream 回退和异常缩水拒绝。
- `tests/unit/services/dream-scheduler.test.ts`
  - 覆盖北京时间 cron 计算与带锁执行入口。
- `tests/unit/utils/logger.test.ts`
  - 覆盖文件日志不可写时不抛错。

## 验证命令

```bash
npm test -- tests/unit/services/dream-analyze.test.ts tests/unit/services/dream-scheduler.test.ts tests/unit/utils/logger.test.ts
npx tsc --noEmit
docker compose --env-file /dev/null config --quiet
npm run docker:samata:up
curl -fsS http://127.0.0.1:3457/health
node --import tsx/esm - <<'NODE'
import { loadDreamFile } from './src/services/dream-analyze.ts';
for (const agent of ['otcclaw', 'ticlaw']) {
  const content = loadDreamFile(agent);
  console.log(agent, content.length, content.slice(0, 40));
}
NODE
```

## 构建与重启

该改动影响 Samata server 运行时调度逻辑，已重新构建 Docker image 并重启 Samata 容器。

- 构建镜像：`samata:3.0.13-61bad821dc81-dirty-20260610155307`
- 当前健康状态：`samata Up ... (healthy)`
- 启动日志确认：`[dream-scheduler] 已调度下一次执行: 2026-06-10T19:00:00Z (0 3 * * *, Asia/Chongqing)`，即北京时间 2026-06-11 03:00。

## 宿主机 Cron

已移除宿主机 crontab 中直接执行本地 Node 的 Samata Dream 条目：

```cron
0 3 * * * source ~/.nvm/nvm.sh && cd /home/xj/work/source/samata && npx tsx scripts/dream.ts >> logs/dream.log 2>&1
```

## Commit

- commit hash: 待提交后回填
