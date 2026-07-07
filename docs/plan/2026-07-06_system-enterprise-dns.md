---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# 系统级企业 DNS 配置

## 背景

Samata 生产宿主机需要稳定解析公司内网域名。此前 Docker Compose 已在 `samata` 服务内配置 `10.55.66.66`、`10.80.66.66`，但宿主机系统解析仍可能先走 `/etc/resolv.conf` 中的公网 DNS，导致普通命令、Node.js 进程、Docker build 或 harness 命令解析内网域名不稳定。

## 决策

- 使用 `systemd-resolved` 作为系统级 DNS 管理入口，通过 drop-in 配置企业 DNS：
  - `DNS=10.55.66.66 10.80.66.66`
  - `FallbackDNS=8.8.8.8`
  - `Domains=~.`
- 不直接编辑 `/run/resolvconf/resolv.conf` 这类生成文件。
- 当 `/etc/resolv.conf` 由 `resolvconf` 生成时，在 `/etc/resolvconf/resolv.conf.d/head` 中插入受管 block，让 glibc 解析优先进入 `127.0.0.53`。
- 提供脚本化 apply/check/rollback，避免人工修改系统文件后不可追踪。

## 改动清单

- 新增 `scripts/configure-system-dns.sh`：
  - `apply`：写入 `systemd-resolved` drop-in，校准 `/etc/resolv.conf` 入口，重启 `systemd-resolved`。
  - `check`：输出 `/etc/resolv.conf`、`resolvectl dns` 和测试域名解析结果。
  - `rollback`：删除 Samata drop-in 和 resolvconf 中的受管 block。
  - 修改系统文件前会备份到 `/etc/samata/dns-backups`。
- 更新 `docs/.vitepress/plan-index.generated.ts`：
  - 由计划索引同步工具纳入本计划。
- 更新根包版本：
  - `package.json` / `package-lock.json` 从 `3.0.23` 递增到 `3.0.24`。

## 验证命令

```text
bash scripts/configure-system-dns.sh check
bash -n scripts/configure-system-dns.sh
npm run docs:plan-sync -- --check
```

系统实际应用后额外验证：

```text
sudo bash scripts/configure-system-dns.sh apply
resolvectl status
getent hosts devops.gf.com.cn
```

## 验证结果

- `bash -n scripts/configure-system-dns.sh`：通过。
- `bash scripts/configure-system-dns.sh check`：通过，输出当前系统状态；当前 `/etc/resolv.conf` 仍为 `8.8.8.8` 优先，脚本提示需执行 `apply` 后才会切到 `127.0.0.53` 优先。
- `npm run docs:plan-sync -- --check`：未通过。脚本已将本次新增 plan 写入 `docs/.vitepress/plan-index.generated.ts`，但仓库既有 plan 文件存在 frontmatter 缺失或 `canonicalDocs` 失效问题，导致检查返回 1；失败项不来自本次新增的 `2026-07-06_system-enterprise-dns.md`。

## Commit Hash

- 待提交后回填。

## 构建与重启影响

- 本次只新增系统配置脚本、计划文档和文档索引，不修改 Samata 应用运行时代码、依赖或数据库迁移。
- 不需要重新构建 Samata Docker image。
- 系统配置应用时会重启 `systemd-resolved`；已运行容器如需使用新的宿主机 DNS 行为，需要按实际部署策略重启。
