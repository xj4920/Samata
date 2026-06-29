# Samata Docker Code SSH 挂载

## 背景

`titans-code-search` 插件在容器内同步 `libra-server` 时，需要执行 `git ls-remote`、`fetch` 或 `clone` 访问 `ssh://git@code.gf.com.cn:30004/gf/libra/libra-server.git`。当前宿主机可以访问 Code 平台，但运行中的 `samata` 容器没有 `/home/node/.ssh`，导致插件报错：

```text
无法读取远端分支 (libra-server): Host key verification failed.
fatal: Could not read from remote repository.
```

在容器内临时跳过 host key 校验后继续报 `Permission denied (publickey)`，说明容器同时缺少 `known_hosts` 和 Code 平台 SSH 私钥。

## 决策

使用部署机运行时目录承载最小 SSH 凭据：`/opt/samata/ssh -> /home/node/.ssh:ro`。

- SSH 凭据不进入镜像、不进入 Git 仓库。
- 容器只读挂载 `/opt/samata/ssh`，降低运行期误改密钥的风险。
- 目录内只放 Code 平台访问所需的 `config`、`known_hosts` 和专用 `id_ed25519_gf`，不挂载个人完整 `~/.ssh`。
- `config` 固定 `IdentitiesOnly yes`、`StrictHostKeyChecking yes` 和 `/home/node/.ssh/known_hosts`。

## 改动清单

- `docker-compose.yml`
  - 为 `samata` 服务新增 `${SAMATA_DEPLOY_ROOT:-/opt/samata}/ssh:/home/node/.ssh:ro`。
- `docs/platform/deployment.md`
  - 补充 `/opt/samata/ssh` 初始化、权限要求、SSH config 示例和容器内验证命令。
- `/opt/samata/ssh`
  - 运行时创建目录并写入 Code 平台专用 SSH 配置、host key 与私钥副本。

## 验证命令

```bash
docker compose --env-file /dev/null config
docker compose --env-file /dev/null up -d --no-build samata
docker exec -u node samata ssh -T code.gf.com.cn
docker exec -u node samata git ls-remote --heads ssh://git@code.gf.com.cn:30004/gf/libra/libra-server.git release-1.68.x
```

## 验证结果

- `docker compose --env-file /dev/null config`：通过，解析后的 `samata` 服务包含 `/opt/samata/ssh:/home/node/.ssh:ro`。
- `docker compose --env-file /dev/null up -d --no-build samata`：通过，容器已重新创建并启动，未重新构建镜像。
- `docker inspect samata`：确认 `/opt/samata/ssh` 以 `Mode=ro`、`RW=false` 挂载到 `/home/node/.ssh`。
- `docker exec -u node samata ssh -T code.gf.com.cn`：通过，返回 Code 平台认证成功信息。
- `docker exec -u node samata git ls-remote --heads ssh://git@code.gf.com.cn:30004/gf/libra/libra-server.git release-1.68.x`：通过，返回 `a5221104644b3538826ba9e26654e8c8de0fbe21 refs/heads/release-1.68.x`。
- `docker exec -u node samata git -C /app/samata/data/plugins/titans-code-search/45ff1179-6294-4537-90d3-637f84c07f52/libra-server/release-1.66.x fetch --depth=1 origin release-1.66.x`：通过，返回 `FETCH_HEAD`，状态码 0。
- `curl -fsS http://127.0.0.1:3457/health`：通过，返回 `{"ok":true}`。

## 构建与重启判断

本次改动只影响 Docker Compose 挂载和部署机运行时 SSH 文件，不影响 TypeScript 编译产物、Docker image 内容、插件构建产物、依赖或数据库迁移，因此不需要重新打镜像。需要重新创建或重启 `samata` 容器，使新增 `/home/node/.ssh` 挂载生效。

## Commit

- Commit hash: 3a2e2fb
