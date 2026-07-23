---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Langfuse Web 外部访问

## 背景

生产 Compose 原先将 Langfuse Web 映射为 `127.0.0.1:3001:3000`，只有容器宿主机可以
打开管理界面。当前需要让受信网络中的其他终端通过宿主机 IP 访问 Langfuse。

## 决策

- 仅把 `langfuse-web` 改为监听所有宿主机接口 `0.0.0.0:3001`。
- PostgreSQL、ClickHouse、Redis、MinIO 和 Langfuse Worker 不增加宿主机端口，继续只在
  Compose 网络内通信。
- 外部访问使用 `http://<宿主机 IP>:3001`；Langfuse 登录认证继续生效。
- `0.0.0.0` 会扩大网络暴露面，生产环境应通过主机防火墙或上游访问控制限制来源网络。

## 改动清单

- `docker-compose.yml`
  - 将 Langfuse Web 端口映射从 `127.0.0.1:3001:3000` 改为
    `0.0.0.0:3001:3000`。
- `README.md`、`docs/platform/deployment.md`
  - 更新本机和受信网络访问方式及安全提示。
- `tests/unit/scripts/render-local-compose.test.ts`
  - 增加 Langfuse Web 全接口监听的 Compose 合约测试。
- `package.json`、`package-lock.json`
  - patch 版本从 `3.1.1` 递增到 `3.1.2`。

## 验证命令

```bash
npm run test:unit -- tests/unit/scripts/render-local-compose.test.ts
git diff --check
docker compose --env-file /dev/null --file /opt/samata/docker-compose.yml config --quiet
docker ps --format 'table {{.Names}}\t{{.Ports}}' | rg 'otcclaw-langfuse'
curl -fsS http://127.0.0.1:3001/api/public/health
curl -fsS http://<宿主机 IP>:3001/api/public/health
```

## 验证结果

- 定向 Compose 单测通过：1 个文件、16 项测试。
- `git diff --check` 通过。
- `/opt/samata/docker-compose.yml` 的 Compose 配置校验通过。
- 在部署锁保护下仅重建 `otcclaw-langfuse`；PostgreSQL、ClickHouse、Redis、MinIO 和
  Worker 保持原运行实例。
- `docker ps` 显示端口映射为 `0.0.0.0:3001->3000/tcp`，`ss` 显示
  `0.0.0.0:3001` 正在监听。
- `127.0.0.1:3001` 和宿主机 `10.49.9.185:3001` 的健康接口均返回
  `{"status":"OK","version":"3.175.0"}`。
- 独立的 `customer-materials-http` 容器通过宿主机 `10.49.9.185:3001` 访问健康接口
  成功，验证了宿主机之外的网络命名空间访问路径。
- 主机 UFW 服务已启用且默认 INPUT 策略为 DROP；当前账户无免密 sudo，无法独立审计或
  修改 UFW 用户规则。Docker 发布端口的跨容器访问已验证，物理外部终端仍应实际打开
  `http://10.49.9.185:3001` 复核所在网络和上游防火墙策略。

## Commit Hash

待提交后填写。

## 构建与部署影响

本次只调整 Compose 端口发布配置，不修改 Langfuse 镜像、应用依赖或数据库结构，无需构建
Docker image，也不涉及数据库迁移。需要重建 `otcclaw-langfuse` 容器使新端口映射生效；
本次已完成该容器重建，现有命名卷和数据保持不变。
