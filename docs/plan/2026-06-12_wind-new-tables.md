---
docModules:
  - external-data
docTopics:
  external-data: Wind PostgreSQL
canonicalDocs:
  - /external-data/
status: implemented
---

# Wind 新增同步表说明补齐

## 背景

dataSync 当前 `config/config.json` 的 `TABLES` 已包含 28 张 Wind 同步表，Samata 的 Wind 数据库说明仍停留在 24 张表。缺失的 4 张表是商品期货日行情、中国期权日行情、中国期权合约信息和封闭式基金日行情。

## 决策

- 以 dataSync `TABLES` 作为表清单来源。
- 字段名、Oracle 原始类型、长度/精度、可空标记和中文说明从 Oracle `WIND` schema 的 `ALL_TAB_COLUMNS` 与 `ALL_COL_COMMENTS` 查询。
- PostgreSQL 查询文档仍使用 Samata 当前正式入口 `10.8.0.1:3395`，不改运行时代码。
- 公司 Code `origin` 当前 `10.55.79.11:30004` 返回 `Connection refused`，已按要求尝试 `git pull --ff-only` 但未成功；本次先完成本地文档改动，暂不提交和推送。

## 改动清单

- `docs/wind-database.md`
  - 表一览从 24 张更新为 28 张。
  - 增加 `CCOMMODITYFUTURESEODPRICES`、`CHINAOPTIONEODPRICES`、`CHINAOPTIONDESCRIPTION`、`CHINACLOSEDFUNDEODPRICE`。
- `docs/oracle-wind-database.md`
  - Oracle Wind 表一览同步更新为 28 张。
- `docs/wind-tables-schema.md`
  - 总览更新为 28 张。
  - 增加 4 张新增表的索引入口。
- `docs/wind-tables/*.md`
  - 新增 4 个分表字段说明文档。
- `docs/wind-schema.json`
  - 通过 `scripts/dump-wind-schema.py` 重新生成，覆盖 dataSync 当前 28 张表。
- `docs/plan/2026-06-12_wind-new-tables.md`
  - 记录本次背景、决策、改动、验证命令、提交与构建影响。

## 验证命令

已执行：

```text
/usr/local/python-3.10.4/bin/python scripts/dump-wind-schema.py
npm run docs:plan-sync
/usr/local/python-3.10.4/bin/python - <<'PY'
# 查询 Oracle ALL_TAB_COLUMNS + ALL_COL_COMMENTS，并与 4 个新增分表文档逐列比较
PY
python3 - <<'PY'
import json
from pathlib import Path
cfg = json.loads(Path('/home/xj/work/source/dataSync/config/config.json').read_text())
tables = [t['name'].split('.')[-1] for t in cfg['TABLES']]
docs = [
    Path('docs/wind-database.md').read_text(),
    Path('docs/oracle-wind-database.md').read_text(),
    Path('docs/wind-tables-schema.md').read_text(),
]
missing = []
for table in tables:
    if not all(table in text for text in docs):
        missing.append(table)
    if not Path(f'docs/wind-tables/{table}.md').exists():
        missing.append(f'{table}.md')
print('missing=', missing)
assert not missing
PY
python3 scripts/verify-wind-schema.py
rg -n "24 张|28 张|CCOMMODITYFUTURESEODPRICES|CHINAOPTIONEODPRICES|CHINAOPTIONDESCRIPTION|CHINACLOSEDFUNDEODPRICE" docs/wind-database.md docs/oracle-wind-database.md docs/wind-tables-schema.md docs/wind-tables
git diff --check
```

## 验证结果

- `/usr/local/python-3.10.4/bin/python scripts/dump-wind-schema.py` 成功连接 Oracle `10.2.89.132:1521/winddb`，重新生成 `docs/wind-schema.json`，输出 28 张表。
- 新增 4 张表的分表文档已与 Oracle `ALL_TAB_COLUMNS` + `ALL_COL_COMMENTS` 逐列比对，列名、类型、长度/精度、可空标记和中文说明一致；结果 `validated_new_tables=4`、`mismatches=[]`。
- dataSync `TABLES` 28 张表在 `docs/wind-database.md`、`docs/oracle-wind-database.md`、`docs/wind-tables-schema.md`、`docs/wind-tables/*.md` 和 `docs/wind-schema.json` 中均已覆盖；结果 `missing=[]`。
- `npm run docs:plan-sync` 成功更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan 缺少 `docModules` 的 warning/error，本次新增 plan 未被点名。
- `python3 scripts/verify-wind-schema.py` 已执行，但该脚本仍按旧版单文件完整 schema 格式解析 `docs/wind-tables-schema.md`，在当前“索引 + 分表文档”结构下读到 `Doc tables: 0`，因此不作为本次通过依据。
- `git diff --check` 通过。

## Commit Hash

- 实现提交：`cf38a2d54834e8e8c23725ddda495e4a9536db8a`
- 回填说明：该 hash 由后续 plan 回填提交写入，最终本地提交见 `git log`。

## 构建与运行影响

- 本次仅更新 Wind 文档、schema 元数据和 plan 留档。
- 不影响运行时构建产物、Docker image、插件构建产物、依赖或数据库迁移。
- 不需要重新构建 Docker image、重启服务或重新生成插件构建产物。
