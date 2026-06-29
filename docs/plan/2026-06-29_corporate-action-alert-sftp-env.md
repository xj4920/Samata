---
docModules:
  - platform
docTopics:
  platform: corporate-action-alert SFTP runtime env
canonicalDocs:
  - /platform/plugin-runtime
status: implemented
---

# Corporate Action Alert SFTP Runtime Env

## 背景

`corporate-action-alert` 插件需要从 SFTP 读取美港日韩股公司行为提醒 CSV。当前开发运行配置 `.env` 和生产容器挂载配置 `/opt/samata/.env` 中未配置公司行为插件的 SFTP 凭据，导致插件在执行同步或定时检查时无法连接远端目录。

用户提出缺少 `CORPACTIONSFTP_HOST`、`CORPACTIONSFTP_USER`、`CORPACTIONSFTP_PASSWORD`。排查插件源码后确认当前插件实际读取 `CORP_ACTION_SFTP_HOST`、`CORP_ACTION_SFTP_USER`、`CORP_ACTION_SFTP_PASSWORD`，因此需要同时补齐插件实际消费的变量，避免只添加别名后运行时仍失败。

## 决策

- 在 `.env` 和 `/opt/samata/.env` 中新增公司行为插件 SFTP 配置。
- `CORPACTIONSFTP_*` 作为用户提到的兼容变量保留；`CORP_ACTION_SFTP_*` 作为插件实际读取变量写入运行环境。
- SFTP 主机、用户、密码复用现有 `FAST_TRADING_SFTP_*` 凭据，不在受版本管理文件中记录明文密钥。
- 远端目录显式配置为 `/EQDHK_internal/data/CorporateActionAlert`，与 `config/corporate-action-alert.json` 中的非密业务配置保持一致。
- 本次不修改插件源码、不修改数据库 memory、不修改 Dockerfile、不修改数据库迁移。

## 改动清单

- `.env`（ignored，本机开发运行配置，不纳入 git 提交）
  - 新增 `CORPACTIONSFTP_HOST`、`CORPACTIONSFTP_USER`、`CORPACTIONSFTP_PASSWORD`。
  - 新增 `CORP_ACTION_SFTP_HOST`、`CORP_ACTION_SFTP_PORT`、`CORP_ACTION_SFTP_USER`、`CORP_ACTION_SFTP_PASSWORD`、`CORP_ACTION_SFTP_REMOTE_BASE`。
- `/opt/samata/.env`（生产容器挂载运行配置，不纳入 git 提交）
  - 同步新增上述变量，使当前 `samata` 容器重启后可读取。
- `docs/plan/2026-06-29_corporate-action-alert-sftp-env.md`
  - 记录背景、决策、改动清单、验证命令、commit hash 和构建重启判断。

## 验证命令

```bash
cd /home/xj/work/source/samata

rg -n "^(CORPACTIONSFTP_HOST|CORPACTIONSFTP_USER|CORPACTIONSFTP_PASSWORD|CORP_ACTION_SFTP_HOST|CORP_ACTION_SFTP_PORT|CORP_ACTION_SFTP_USER|CORP_ACTION_SFTP_PASSWORD|CORP_ACTION_SFTP_REMOTE_BASE)=" .env /opt/samata/.env | sed -E 's/=.*/=<redacted>/'

node --input-type=module <<'NODE'
import fs from 'node:fs';
for (const file of ['.env', '/opt/samata/.env']) {
  const text = fs.readFileSync(file, 'utf8');
  const env = Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
  for (const key of [
    'CORPACTIONSFTP_HOST',
    'CORPACTIONSFTP_USER',
    'CORPACTIONSFTP_PASSWORD',
    'CORP_ACTION_SFTP_HOST',
    'CORP_ACTION_SFTP_PORT',
    'CORP_ACTION_SFTP_USER',
    'CORP_ACTION_SFTP_PASSWORD',
    'CORP_ACTION_SFTP_REMOTE_BASE',
  ]) {
    if (!env[key]) throw new Error(`${file}: missing ${key}`);
  }
  console.log(`${file}: corporate action SFTP env present`);
}
NODE

cd /home/xj/work/source/samata-plugin-work/corporate-action-alert

node --input-type=module <<'NODE'
import fs from 'node:fs';
import { createRequire } from 'node:module';
import SftpClient from 'ssh2-sftp-client';
const requireFromSamata = createRequire('/home/xj/work/source/samata/package.json');
const dotenv = requireFromSamata('dotenv');
const env = dotenv.parse(fs.readFileSync('/opt/samata/.env'));
const sftp = new SftpClient();
await sftp.connect({
  host: env.CORP_ACTION_SFTP_HOST,
  port: Number(env.CORP_ACTION_SFTP_PORT || '22'),
  username: env.CORP_ACTION_SFTP_USER,
  password: env.CORP_ACTION_SFTP_PASSWORD,
  readyTimeout: 10000,
  retries: 1,
});
const files = await sftp.list(env.CORP_ACTION_SFTP_REMOTE_BASE);
await sftp.end();
console.log(`corporate-action-alert remote list ok, entries=${files.length}`);
NODE

cd /home/xj/work/source/samata

docker compose restart samata
docker inspect samata --format '{{.State.Health.Status}}'
docker exec samata sh -lc 'cd /app/samata && node -r dotenv/config -e "const keys=[\"CORPACTIONSFTP_HOST\",\"CORPACTIONSFTP_USER\",\"CORPACTIONSFTP_PASSWORD\",\"CORP_ACTION_SFTP_HOST\",\"CORP_ACTION_SFTP_USER\",\"CORP_ACTION_SFTP_PASSWORD\",\"CORP_ACTION_SFTP_REMOTE_BASE\"]; for (const key of keys) { if (!process.env[key]) process.exit(1); } console.log(\"corporate action env loaded\")"'

git diff --check -- docs/plan/2026-06-29_corporate-action-alert-sftp-env.md
git status --short --ignored=matching -- .env docs/plan/2026-06-29_corporate-action-alert-sftp-env.md
```

## 验证结果

- `rg -n ... .env /opt/samata/.env | sed -E 's/=.*/=<redacted>/'`：通过，两个运行环境文件均已存在全部目标变量。
- Node 非空校验通过：`.env` 与 `/opt/samata/.env` 均输出 `corporate action SFTP env present`。
- dotenv 解析校验通过：`CORP_ACTION_SFTP_HOST`、`CORP_ACTION_SFTP_USER`、`CORP_ACTION_SFTP_PASSWORD` 与现有 `FAST_TRADING_SFTP_*` 源值一致。
- SFTP 只读目录验证通过：`corporate-action-alert remote list ok, entries=7`。
- `docker compose restart samata`：通过。
- `docker inspect samata --format '{{.State.Health.Status}}'`：最终恢复为 `healthy`。
- `docker logs --since 2m samata`：确认 `Plugin [corporate-action-alert]: 3 tools loaded`。
- 容器内 dotenv 加载验证通过：`corporate action env loaded`。
- `git diff --check -- docs/plan/2026-06-29_corporate-action-alert-sftp-env.md`：通过。
- `git status --short --ignored=matching -- .env docs/plan/2026-06-29_corporate-action-alert-sftp-env.md`：确认 `.env` 为 ignored，留档文档为待提交文件。

## Commit Hash

- 待提交。

## 构建与重启判断

本次只修改运行时 `.env` 与留档文档，不涉及 TypeScript 代码、依赖、数据库迁移、Docker image 或插件构建产物；无需重新构建镜像或插件构建产物。生产容器需要重启以重新加载 `.env`。

- 已执行 `docker compose restart samata`。
- 已确认 `samata` 容器恢复为 `healthy`。
- 已确认容器内 `/app/samata/.env` 可通过 dotenv 加载公司行为插件 SFTP 变量。
