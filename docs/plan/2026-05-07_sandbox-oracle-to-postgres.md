# Sandbox Oracle -> PostgreSQL Migration

## Current State

The sandbox (`sandbox_exec` tool) lets the otcclaw agent run Python scripts to query the Wind financial database. Currently:
- Uses `oracledb` Python library connecting to Oracle at `10.2.89.132:1521/winddb`
- Connection details live in [`docs/oracle-wind-database.md`](../oracle-wind-database.md)
- Agent prompt references Oracle in `config/agents/otcclaw.md` (lines 82-91)
- Tool description in [`src/tools/sandbox-tools.ts`](../../src/tools/sandbox-tools.ts) (line 50) lists `oracledb` as pre-installed
- Schema metadata in [`docs/wind-schema.json`](../wind-schema.json) remains valid (column names are the same in PG)

The bwrap sandbox shares network namespace (no `--unshare-net`), so the sandbox can access `localhost:5432`.

## Changes

### 1. Docker Compose for PostgreSQL

Create `docker-compose.yml` at project root:
- Image: `postgres:16`
- Port: `5432:5432`
- Database: `wind_sync`, User: `wind_sync`, Password: `wind_sync`
- Volume for data persistence: `./data/postgres:/var/lib/postgresql/data`

### 2. Update documentation: `docs/oracle-wind-database.md` -> `docs/wind-database.md`

Rename and rewrite to reflect PostgreSQL:
- Connection info: `localhost:5432/wind_sync`
- Python library: `psycopg2` (replaces `oracledb`)
- Remove Oracle-specific content: `oracledb.init_oracle_client()`, DSN format, LOB column handling, `to_date()` Oracle syntax
- Update query patterns to PostgreSQL syntax (standard SQL, date comparisons use `DATE 'YYYY-MM-DD'` or string comparison)
- Keep the same table list (column names unchanged in PG)
- Note: PG table names are case-sensitive when quoted; the dataSync `create_tables_pg.py` uses `"TABLE_NAME"` (uppercase quoted), so queries need `FROM "ASHAREEODPRICES"` etc.
- Reference `docs/wind-tables-schema.md` for complete column definitions instead of `docs/wind-schema.json`

### 2b. Copy schema from dataSync: `docs/wind-tables-schema.md`

Copy `../dataSync/doc/tables_schema.md` into `docs/wind-tables-schema.md`. This file has 24 tables with complete field metadata including Chinese descriptions, data types, and nullable info -- much richer than the old `wind-schema.json` (which only had name/type/length/nullable without descriptions).

The agent will `read_file docs/wind-tables-schema.md` to get column names before writing SQL. This replaces `docs/wind-schema.json` as the primary schema reference.

### 3. Update agent prompt: `config/agents/otcclaw.md` lines 82-91

Change the "数据查询参考" section:
- Replace "Wind 金融数据库（Oracle）" with "Wind 金融数据库（PostgreSQL）"
- Step 1: read `docs/wind-database.md` for connection info and query patterns
- Step 2: read `docs/wind-tables-schema.md` for column definitions (replaces `docs/wind-schema.json`)
- Step 3: verify `psycopg2` instead of `oracledb`; update connection code pattern
- Remove Oracle-specific pip install notes

### 4. Update file allowlist: `config/agents/otcclaw.files.json`

Replace current list with:
```json
[
  "docs/wind-database.md",
  "docs/wind-tables-schema.md"
]
```

### 5. Update sandbox_exec tool description: `src/tools/sandbox-tools.ts` line 50

Replace `oracledb` with `psycopg2` in the pre-installed packages list.

### 6. Add `.env` variables for PG connection

Add to `.env.example` (and `.env`):
```
# PostgreSQL Wind 数据 (本地 Docker)
PG_WIND_HOST=127.0.0.1
PG_WIND_PORT=5432
PG_WIND_USER=wind_sync
PG_WIND_PASS=wind_sync
PG_WIND_DATABASE=wind_sync
```

### 7. Ensure psycopg2 is available in sandbox Python

The sandbox uses `/usr/local/python-3.10.4`. Need to install `psycopg2-binary` in that environment (one-time setup):
```bash
/usr/local/python-3.10.4/bin/pip3.10 install psycopg2-binary
```

### Files NOT changed
- `src/commands/sandbox.ts` -- no changes needed, sandbox exec logic is DB-agnostic

### Files deprecated (can delete later)
- `docs/wind-schema.json` -- replaced by `docs/wind-tables-schema.md` (richer, with Chinese descriptions)
- `docs/oracle-wind-database.md` -- replaced by `docs/wind-database.md`
- `scripts/dump-wind-schema.py` -- no longer needed (was for dumping Oracle schema)
