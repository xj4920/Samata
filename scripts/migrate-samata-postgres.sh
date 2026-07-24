#!/usr/bin/env bash
set -euo pipefail

# This migration is intentionally narrow. The source database/container names
# are not configurable so an operator cannot accidentally migrate wind_sync.
SOURCE_CONTAINER="wind_sync_pg"
SOURCE_DATABASE="samata"
SOURCE_USER="wind_sync"

TARGET_SERVICE="langfuse-postgres"
TARGET_CONTAINER="otcclaw-langfuse-postgres"
TARGET_ADMIN_USER="langfuse"
TARGET_DATABASE="samata"
TARGET_APP_USER="samata_app"
OTCCLAW_CONTAINER="otcclaw"
SESSION_AUDIT_CONTAINER="otcclaw-session-audit"
TARGET_POSTGRES_IMAGE=""

DEPLOY_ROOT="/opt/samata"
COMPOSE_SOURCE_FILE="${SAMATA_COMPOSE_FILE:-$DEPLOY_ROOT/docker-compose.yml}"
COMPOSE_FILE="$COMPOSE_SOURCE_FILE"
COMPOSE_SHA256=""
COMPOSE_SNAPSHOT=""
PGDATA_DIR="$DEPLOY_ROOT/data/postgres"
BACKUP_ROOT="${SAMATA_PG_MIGRATION_BACKUP_ROOT:-$DEPLOY_ROOT/backups/postgres-migration}"
DEPLOY_LOCK_TARGET="$DEPLOY_ROOT"
MODE="${1:---dry-run}"

FRESH_DATA_VOLUMES=(
  "otcclaw_prod_langfuse_clickhouse_data_v1"
  "otcclaw_prod_langfuse_clickhouse_logs_v1"
  "otcclaw_prod_langfuse_minio_data_v1"
)

LANGFUSE_CONTAINERS=(
  "otcclaw-langfuse"
  "otcclaw-langfuse-worker"
  "otcclaw-langfuse-clickhouse-server"
  "otcclaw-langfuse-minio"
  "otcclaw-langfuse-redis"
  "otcclaw-samata-postgres-init"
)

usage() {
  cat <<'USAGE'
Usage: bash scripts/migrate-samata-postgres.sh [--dry-run|--execute]

Migrates exactly one business database:
  wind_sync_pg/samata -> otcclaw-langfuse-postgres/samata

The target PostgreSQL instance is initialized from an empty bind directory at
/opt/samata/data/postgres. Existing Langfuse PostgreSQL, ClickHouse, and MinIO
history is not dumped or restored. The source container and all old Docker
volumes are retained and never modified or deleted.

--dry-run is read-only. --execute uses a short-lived, network-disabled
PostgreSQL image helper to set the bind directory to uid/gid 999 and mode 0700,
so the operator only needs normal Docker access.

Optional path overrides:
  SAMATA_COMPOSE_FILE
  SAMATA_PG_MIGRATION_BACKUP_ROOT
USAGE
}

case "$MODE" in
  --dry-run|--execute) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'Migration failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

container_is_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]
}

require_running_container() {
  container_is_running "$1" || fail "container is not running: $1"
}

compose() {
  docker compose --env-file /dev/null --project-name samata --file "$COMPOSE_FILE" "$@"
}

cleanup_compose_snapshot() {
  local snapshot="$COMPOSE_SNAPSHOT"
  [[ -n "$snapshot" ]] || return 0

  if rm -f -- "$snapshot"; then
    COMPOSE_SNAPSHOT=""
  else
    printf 'Warning: could not remove Compose snapshot; remove it manually: %s\n' \
      "$snapshot" >&2
  fi
  return 0
}

create_compose_snapshot() {
  COMPOSE_SNAPSHOT="$(mktemp /tmp/samata-migration-compose.XXXXXX.yml)"
  chmod 0600 "$COMPOSE_SNAPSHOT"
  cp -- "$COMPOSE_SOURCE_FILE" "$COMPOSE_SNAPSHOT"
  local snapshot_hash
  snapshot_hash="$(sha256sum "$COMPOSE_SNAPSHOT" | awk '{print $1}')"
  [[ "$snapshot_hash" == "$COMPOSE_SHA256" ]] \
    || fail "rendered Compose changed during preflight; rerun the migration"
  COMPOSE_FILE="$COMPOSE_SNAPSHOT"
}

source_psql() {
  docker exec "$SOURCE_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
    -U "$SOURCE_USER" -d "$SOURCE_DATABASE" "$@"
}

target_admin_psql() {
  local database="$1"
  shift
  docker exec "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
    -U "$TARGET_ADMIN_USER" -d "$database" "$@"
}

user_table_count() {
  local side="$1"
  local query
  query="SELECT count(*) FROM pg_tables
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema');"
  if [[ "$side" == "source" ]]; then
    source_psql -Atc "$query"
  else
    target_admin_psql "$TARGET_DATABASE" -Atc "$query"
  fi
}

write_exact_counts() {
  local side="$1"
  local output="$2"
  local tables
  local query
  query="SELECT quote_ident(schemaname) || '.' || quote_ident(tablename)
         FROM pg_tables
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schemaname, tablename;"

  if [[ "$side" == "source" ]]; then
    tables="$(source_psql -Atc "$query")"
  else
    tables="$(target_admin_psql "$TARGET_DATABASE" -Atc "$query")"
  fi

  : >"$output"
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    local count
    if [[ "$side" == "source" ]]; then
      count="$(source_psql -Atc "SELECT count(*) FROM $table;")"
    else
      count="$(target_admin_psql "$TARGET_DATABASE" -Atc "SELECT count(*) FROM $table;")"
    fi
    printf '%s\t%s\n' "$table" "$count" >>"$output"
  done <<<"$tables"
}

write_catalog_summary() {
  local side="$1"
  local output="$2"
  local query
  query="
    SELECT 'constraints', count(*) FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    UNION ALL
    SELECT 'functions', count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    UNION ALL
    SELECT 'indexes', count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind IN ('i', 'I')
    UNION ALL
    SELECT 'large_objects', count(*) FROM pg_largeobject_metadata
    UNION ALL
    SELECT 'materialized_views', count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind = 'm'
    UNION ALL
    SELECT 'sequences', count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind = 'S'
    UNION ALL
    SELECT 'tables', count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'triggers', count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND NOT t.tgisinternal
    UNION ALL
    SELECT 'views', count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind = 'v'
    ORDER BY 1;"

  if [[ "$side" == "source" ]]; then
    source_psql -AtF $'\t' -c "$query" >"$output"
  else
    target_admin_psql "$TARGET_DATABASE" -AtF $'\t' -c "$query" >"$output"
  fi
}

write_sequence_states() {
  local side="$1"
  local output="$2"
  local sequences
  local query
  query="SELECT quote_ident(schemaname) || '.' || quote_ident(sequencename)
         FROM pg_sequences
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schemaname, sequencename;"

  if [[ "$side" == "source" ]]; then
    sequences="$(source_psql -Atc "$query")"
  else
    sequences="$(target_admin_psql "$TARGET_DATABASE" -Atc "$query")"
  fi

  : >"$output"
  while IFS= read -r sequence; do
    [[ -n "$sequence" ]] || continue
    local state
    if [[ "$side" == "source" ]]; then
      state="$(source_psql -AtF $'\t' -c "SELECT last_value, is_called FROM $sequence;")"
    else
      state="$(target_admin_psql "$TARGET_DATABASE" -AtF $'\t' \
        -c "SELECT last_value, is_called FROM $sequence;")"
    fi
    printf '%s\t%s\n' "$sequence" "$state" >>"$output"
  done <<<"$sequences"
}

directory_is_empty() {
  [[ -d "$1" ]] && [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

validate_pgdata_path() {
  [[ "$PGDATA_DIR" == /* ]] || fail "PostgreSQL data path must be absolute: $PGDATA_DIR"
  [[ "$PGDATA_DIR" != "/" ]] || fail "refusing PostgreSQL data path /"
  [[ ! -L "$PGDATA_DIR" ]] || fail "PostgreSQL data path must not be a symlink: $PGDATA_DIR"
  if [[ -e "$PGDATA_DIR" ]]; then
    [[ -d "$PGDATA_DIR" ]] || fail "PostgreSQL data path is not a directory: $PGDATA_DIR"
    directory_is_empty "$PGDATA_DIR" \
      || fail "PostgreSQL data path is not empty: $PGDATA_DIR"
  fi
  [[ -d "$(dirname "$PGDATA_DIR")" ]] \
    || fail "parent directory does not exist: $(dirname "$PGDATA_DIR")"
}

validate_backup_root() {
  local normalized_pgdata
  local normalized_backup
  normalized_pgdata="$(realpath -m "$PGDATA_DIR")"
  normalized_backup="$(realpath -m "$BACKUP_ROOT")"
  [[ "$normalized_backup" != "$normalized_pgdata" ]] \
    || fail "backup root must not equal PostgreSQL data path: $normalized_backup"
  [[ "$normalized_backup" != "$normalized_pgdata/"* ]] \
    || fail "backup root must not be inside PostgreSQL data path: $normalized_backup"
  [[ "$normalized_pgdata" != "$normalized_backup/"* ]] \
    || fail "backup root must not contain PostgreSQL data path: $normalized_backup"
}

validate_compose_contract() {
  [[ -f "$COMPOSE_FILE" ]] || fail "generated compose not found: $COMPOSE_FILE"
  if grep -Fq '{{string "' "$COMPOSE_FILE"; then
    fail "compose still contains unresolved template placeholders: $COMPOSE_FILE"
  fi

  compose config --quiet

  local config_json
  config_json="$(mktemp)"
  chmod 600 "$config_json"
  compose config --format json >"$config_json"
  if ! node - "$config_json" "$PGDATA_DIR" "$COMPOSE_FILE" <<'NODE'
const fs = require('node:fs');
const { parse: parseYaml } = require('yaml');
const [configPath, pgdataPath, composePath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const source = parseYaml(fs.readFileSync(composePath, 'utf8'));
const services = config.services || {};

function fail(message) {
  process.stderr.write(`Compose contract error: ${message}\n`);
  process.exit(1);
}

const otcclaw = services.otcclaw;
if (!otcclaw) fail('otcclaw service is missing');
if (services.wind_sync_pg) fail('wind_sync_pg must remain an external service');
const otcclawHealthcheck = source.services?.otcclaw?.healthcheck;
if (!Array.isArray(otcclawHealthcheck?.test)
    || !otcclawHealthcheck.test.join(' ').includes('/health')) {
  fail('otcclaw must define the CLI API healthcheck');
}
const runtimeEnvironment = otcclaw.environment || {};
if (runtimeEnvironment.SAMATA_DISABLED_TOOLS !== 'generate_image,generate_video') {
  fail('production tool deny list must keep analyze_sbl_usage enabled');
}
for (const name of ['SFTP_HOST', 'SFTP_USER', 'SFTP_PASSWORD']) {
  if (!runtimeEnvironment[name]) fail(`${name} must be rendered`);
}
for (const name of [
  'WIND_PG_HOST',
  'WIND_PG_PORT',
  'WIND_PG_DATABASE',
  'WIND_PG_USER',
  'WIND_PG_PASSWORD',
]) {
  if (name in runtimeEnvironment) fail(`${name} must not be configured`);
}
if (services['sbl-wind-check']) fail('sbl-wind-check must not be configured');
const otcclawNetworks = Array.isArray(otcclaw.networks)
  ? otcclaw.networks
  : Object.keys(otcclaw.networks || {});
if (otcclawNetworks.includes('wind-sync')) {
  fail('otcclaw must not join the wind-sync network');
}
if (source.networks?.['wind-sync']) {
  fail('the production Compose must not declare the wind-sync network');
}

const postgresMount = (services['langfuse-postgres']?.volumes || [])
  .find(volume => volume.target === '/var/lib/postgresql/data');
if (!postgresMount) fail('langfuse-postgres PGDATA mount is missing');
if (postgresMount.type !== 'bind') fail('langfuse-postgres PGDATA must be a bind mount');
if (postgresMount.source !== pgdataPath) {
  fail(`langfuse-postgres PGDATA source must be ${pgdataPath}`);
}
const sourcePostgresMount = (source.services?.['langfuse-postgres']?.volumes || [])
  .find(volume => volume?.target === '/var/lib/postgresql/data');
if (sourcePostgresMount?.bind?.create_host_path !== false) {
  fail('langfuse-postgres PGDATA must set bind.create_host_path=false');
}

const guard = (services.otcclaw?.volumes || [])
  .find(volume => volume.target === '/app/samata/data/postgres');
if (!guard || guard.type !== 'volume' || guard.read_only !== true) {
  fail('otcclaw PostgreSQL guard must be a read-only volume');
}
if (guard.volume?.nocopy !== true) {
  fail('otcclaw PostgreSQL guard must set volume.nocopy=true');
}

const audit = services['session-audit'];
if (!audit) fail('session-audit service is missing');
const auditSource = source.services?.['session-audit'];
if (audit.container_name !== 'otcclaw-session-audit') {
  fail('session-audit container name is not fixed');
}
if (audit.environment?.SESSION_AUDIT_CRON !== '30 23 * * *'
    || audit.environment?.SESSION_AUDIT_TIMEZONE !== 'Asia/Chongqing'
    || audit.environment?.SESSION_AUDIT_AGENTS !== 'ticlaw,otcclaw'
    || audit.environment?.SESSION_AUDIT_RUN_ON_START !== '1') {
  fail('session-audit schedule or agent scope is invalid');
}
if (audit.environment?.LOG_PG_HOST !== 'langfuse-postgres'
    || audit.environment?.LOG_PG_DB !== 'samata') {
  fail('session-audit PostgreSQL target is invalid');
}
if (!Array.isArray(auditSource?.entrypoint)
    || !auditSource.entrypoint.join(' ').includes('tsx/esm')
    || !Array.isArray(auditSource?.command)
    || !auditSource.command.includes('src/services/session-audit-scheduler.ts')) {
  fail('session-audit scheduler entrypoint is invalid');
}
const auditGuard = (audit.volumes || [])
  .find(volume => volume.target === '/app/samata/data/postgres');
if (!auditGuard || auditGuard.type !== 'volume' || auditGuard.read_only !== true
    || auditGuard.volume?.nocopy !== true) {
  fail('session-audit PostgreSQL guard is invalid');
}
const auditData = (audit.volumes || [])
  .find(volume => volume.target === '/app/samata/data');
if (!auditData || auditData.type !== 'bind' || auditData.read_only !== true) {
  fail('session-audit must mount Samata data read-only');
}

const expectedVolumes = new Set([
  'otcclaw_prod_langfuse_clickhouse_data_v1',
  'otcclaw_prod_langfuse_clickhouse_logs_v1',
  'otcclaw_prod_langfuse_minio_data_v1',
]);
const configuredNames = new Set(
  Object.values(config.volumes || {}).map(volume => volume?.name).filter(Boolean),
);
for (const name of expectedVolumes) {
  if (!configuredNames.has(name)) fail(`fresh Langfuse volume is missing: ${name}`);
}

const expectedMounts = [
  ['langfuse-clickhouse', '/var/lib/clickhouse', 'otcclaw_prod_langfuse_clickhouse_data_v1'],
  ['langfuse-clickhouse', '/var/log/clickhouse-server', 'otcclaw_prod_langfuse_clickhouse_logs_v1'],
  ['langfuse-minio', '/data', 'otcclaw_prod_langfuse_minio_data_v1'],
];
for (const [serviceName, target, expectedName] of expectedMounts) {
  const mount = (services[serviceName]?.volumes || [])
    .find(volume => volume.target === target);
  if (!mount || mount.type !== 'volume') {
    fail(`${serviceName} must use a volume at ${target}`);
  }
  const resolvedName = config.volumes?.[mount.source]?.name;
  if (resolvedName !== expectedName) {
    fail(`${serviceName}:${target} must resolve to ${expectedName}`);
  }
}

for (const name of configuredNames) {
  if (name.startsWith('samata_langfuse_')) {
    fail(`legacy Langfuse volume must not be mounted: ${name}`);
  }
}
NODE
  then
    rm -f "$config_json"
    fail "generated compose does not satisfy the migration storage contract"
  fi
  rm -f "$config_json"
}

validate_fresh_volumes() {
  local volume
  for volume in "${FRESH_DATA_VOLUMES[@]}"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      fail "fresh Langfuse volume already exists; refusing to reuse it: $volume"
    fi
  done
}

claim_fresh_volumes() {
  validate_fresh_volumes
  local volume
  local actual_claim
  for volume in "${FRESH_DATA_VOLUMES[@]}"; do
    # Register the candidate before creation. Cleanup still requires our exact
    # claim label, so a concurrently created foreign volume is never removed.
    claimed_fresh_volumes+=("$volume")
    docker volume create \
      --label "com.samata.postgres-migration-claim=$fresh_volume_claim" \
      "$volume" >/dev/null
    actual_claim="$(docker volume inspect --format \
      '{{index .Labels "com.samata.postgres-migration-claim"}}' "$volume")"
    [[ "$actual_claim" == "$fresh_volume_claim" ]] \
      || fail "fresh Langfuse volume was concurrently created by another process: $volume"
  done
}

cleanup_unused_claimed_volumes() {
  local volume
  local actual_claim
  local attached_containers
  for volume in "${claimed_fresh_volumes[@]}"; do
    actual_claim="$(docker volume inspect --format \
      '{{index .Labels "com.samata.postgres-migration-claim"}}' "$volume" 2>/dev/null || true)"
    if [[ "$actual_claim" == "$fresh_volume_claim" ]]; then
      attached_containers="$(docker ps -aq --filter "volume=$volume" 2>/dev/null || true)"
      if [[ -z "$attached_containers" ]]; then
        docker volume rm "$volume" >/dev/null 2>&1 || true
      else
        printf 'Preserving claimed volume because a container references it: %s\n' \
          "$volume" >&2
      fi
    fi
  done
}

validate_claimed_fresh_volumes_unmounted() {
  local volume
  local actual_claim
  local attached_containers
  for volume in "${claimed_fresh_volumes[@]}"; do
    actual_claim="$(docker volume inspect --format \
      '{{index .Labels "com.samata.postgres-migration-claim"}}' "$volume" 2>/dev/null || true)"
    [[ "$actual_claim" == "$fresh_volume_claim" ]] \
      || fail "fresh Langfuse volume claim changed unexpectedly: $volume"
    attached_containers="$(docker ps -aq --filter "volume=$volume")"
    [[ -z "$attached_containers" ]] \
      || fail "fresh Langfuse volume was attached by a concurrent deployment: $volume"
  done
}

check_disk_budget() {
  local source_bytes="$1"
  local existing_path
  existing_path="$(dirname "$PGDATA_DIR")"
  local available_kb
  available_kb="$(df -Pk "$existing_path" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || fail "could not determine free disk space"

  # Budget for the compressed dump, restored PGDATA/WAL, and migration headroom.
  local required_bytes=$(( source_bytes * 4 + 1073741824 ))
  local available_bytes=$(( available_kb * 1024 ))
  log "disk budget: required >= $(( required_bytes / 1048576 )) MiB; available $(( available_bytes / 1048576 )) MiB"
  (( available_bytes >= required_bytes )) \
    || fail "insufficient free space under $existing_path"
}

wait_for_healthy_container() {
  local container="$1"
  local attempts="${2:-90}"
  local status
  for ((i = 1; i <= attempts; i += 1)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container" 2>/dev/null || true)"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      fail "container stopped while waiting for readiness: $container ($status)"
    fi
    sleep 2
  done
  fail "timed out waiting for container readiness: $container"
}

wait_for_session_audit_completion() {
  local attempts="${1:-90}"
  local status
  for ((i = 1; i <= attempts; i += 1)); do
    status="$(docker exec "$SESSION_AUDIT_CONTAINER" node -e '
      const fs = require("node:fs");
      try {
        const heartbeat = JSON.parse(fs.readFileSync(
          "/app/samata/logs/daily_usage/.session-audit-heartbeat.json", "utf8"
        ));
        process.stdout.write(String(heartbeat.status || "missing"));
      } catch {
        process.stdout.write("missing");
      }
    ' 2>/dev/null || true)"
    if [[ "$status" == "completed" ]]; then
      return 0
    fi
    if [[ "$status" == "failed" ]]; then
      fail "initial session audit failed"
    fi
    sleep 2
  done
  fail "timed out waiting for initial session audit completion"
}

validate_target_mount() {
  local mount
  mount="$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Source}}{{end}}{{end}}' \
    "$TARGET_CONTAINER")"
  [[ "$mount" == "bind|$PGDATA_DIR" ]] \
    || fail "target PGDATA mount mismatch: expected bind|$PGDATA_DIR, got $mount"

  local ownership
  ownership="$(stat -c '%u:%g:%a' "$PGDATA_DIR")"
  [[ "$ownership" == "999:999:700" ]] \
    || fail "target PGDATA ownership/mode mismatch: expected 999:999:700, got $ownership"
}

prepare_pgdata_directory() {
  if [[ ! -e "$PGDATA_DIR" ]]; then
    mkdir "$PGDATA_DIR" \
      || fail "cannot create $PGDATA_DIR; prepare its parent for the deployment user"
  fi

  [[ -n "$TARGET_POSTGRES_IMAGE" ]] || fail "target PostgreSQL image was not resolved"
  docker image inspect "$TARGET_POSTGRES_IMAGE" >/dev/null 2>&1 \
    || fail "target PostgreSQL image is not available locally: $TARGET_POSTGRES_IMAGE"
  docker run --rm \
    --network none \
    --read-only \
    --user 0:0 \
    --mount "type=bind,source=$PGDATA_DIR,target=/pgdata" \
    --entrypoint /bin/sh \
    "$TARGET_POSTGRES_IMAGE" \
    -ec 'chown 999:999 /pgdata && chmod 0700 /pgdata'
}

preflight() {
  require_command awk
  require_command cp
  require_command df
  require_command diff
  require_command docker
  require_command find
  require_command flock
  require_command grep
  require_command mktemp
  require_command node
  require_command realpath
  require_command sha256sum
  require_command sort

  [[ -d "$DEPLOY_LOCK_TARGET" && ! -L "$DEPLOY_LOCK_TARGET" ]] \
    || fail "trusted deployment root is missing or is a symlink: $DEPLOY_LOCK_TARGET"
  # Lock the trusted deployment directory inode itself. This avoids creating
  # or truncating a predictable lock file and is shared by repository deploy
  # entrypoints.
  exec 9<"$DEPLOY_LOCK_TARGET"
  flock -n 9 || fail "another Samata deployment or PostgreSQL migration is active"

  local compose_hash_before
  compose_hash_before="$(sha256sum "$COMPOSE_SOURCE_FILE" | awk '{print $1}')"
  validate_compose_contract
  COMPOSE_SHA256="$(sha256sum "$COMPOSE_SOURCE_FILE" | awk '{print $1}')"
  [[ "$COMPOSE_SHA256" == "$compose_hash_before" ]] \
    || fail "rendered Compose changed while validating preflight"
  validate_pgdata_path
  validate_backup_root
  validate_fresh_volumes
  require_running_container "$SOURCE_CONTAINER"

  local source_identity
  source_identity="$(source_psql -AtF $'\t' \
    -c "SELECT current_database(), current_user, current_setting('server_version_num');")"
  local source_database source_user source_version
  IFS=$'\t' read -r source_database source_user source_version <<<"$source_identity"
  [[ "$source_database" == "$SOURCE_DATABASE" && "$source_user" == "$SOURCE_USER" ]] \
    || fail "source identity mismatch: $source_database/$source_user"
  [[ "$source_version" =~ ^[0-9]+$ ]] || fail "could not determine source PostgreSQL version"
  (( source_version / 10000 == 16 )) \
    || fail "source PostgreSQL major version must be 16, got $source_version"

  local source_tables
  source_tables="$(user_table_count source)"
  [[ "$source_tables" =~ ^[0-9]+$ ]] || fail "could not determine source table count"
  (( source_tables > 0 )) || fail "source database has no user tables"

  local source_bytes
  source_bytes="$(source_psql -Atc "SELECT pg_database_size(current_database());")"
  [[ "$source_bytes" =~ ^[0-9]+$ ]] || fail "could not determine source database size"
  check_disk_budget "$source_bytes"

  log "source locked to $SOURCE_CONTAINER/$SOURCE_DATABASE ($source_tables user tables, $(( source_bytes / 1048576 )) MiB)"
  log "target PGDATA will be initialized fresh at $PGDATA_DIR"
  log "existing Langfuse history will not be dumped or restored"
  if container_is_running "$TARGET_CONTAINER"; then
    local current_mount
    current_mount="$(docker inspect --format \
      '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}' \
      "$TARGET_CONTAINER")"
    log "current Langfuse PostgreSQL is running and will be replaced during execute ($current_mount)"
  else
    log "current Langfuse PostgreSQL is not running; execute will still initialize a fresh instance"
  fi
}

preflight

if [[ "$MODE" == "--dry-run" ]]; then
  log "dry-run completed; no directories, volumes, containers, or databases were changed"
  exit 0
fi

trap cleanup_compose_snapshot EXIT
create_compose_snapshot

log "ensuring every target image is available before the downtime window"
compose pull --policy missing
mapfile -t target_images < <(compose config --images | sort -u)
(( ${#target_images[@]} > 0 )) || fail "generated compose did not resolve any images"
for target_image in "${target_images[@]}"; do
  docker image inspect "$target_image" >/dev/null 2>&1 \
    || fail "target image is not available locally after pull: $target_image"
done
TARGET_POSTGRES_IMAGE="$(compose config --format json | node -e "
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const image = JSON.parse(input).services?.['langfuse-postgres']?.image;
    if (image) process.stdout.write(image);
  });
")"
[[ -n "$TARGET_POSTGRES_IMAGE" ]] || fail "could not resolve target PostgreSQL image"
docker image inspect "$TARGET_POSTGRES_IMAGE" >/dev/null 2>&1 \
  || fail "target PostgreSQL image was not pulled: $TARGET_POSTGRES_IMAGE"

umask 077
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$BACKUP_ROOT/$timestamp"
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"

phase="source_available"
stopped_containers=()
claimed_fresh_volumes=()
fresh_volume_claim="samata-postgres-migration-$timestamp-$$"

record_and_stop() {
  local container="$1"
  if container_is_running "$container"; then
    stopped_containers+=("$container")
    log "stopping $container"
    docker stop --time 60 "$container" >/dev/null
  fi
}

restart_stopped_containers() {
  local container
  local i
  for ((i = ${#stopped_containers[@]} - 1; i >= 0; i -= 1)); do
    container="${stopped_containers[$i]}"
    if container_exists "$container"; then
      docker start "$container" >/dev/null 2>&1 || true
    fi
  done
}

handle_exit() {
  local status=$?
  cleanup_compose_snapshot
  if (( status == 0 )); then
    return
  fi

  if [[ "$phase" == "otcclaw_starting" || "$phase" == "otcclaw_started" ]]; then
    if container_is_running "$SESSION_AUDIT_CONTAINER"; then
      printf 'Stopping session audit because a final deployment gate failed.\n' >&2
      docker stop --time 60 "$SESSION_AUDIT_CONTAINER" >/dev/null 2>&1 || true
    fi
    if container_is_running "$OTCCLAW_CONTAINER"; then
      printf 'Stopping OtcClaw because a final deployment gate failed.\n' >&2
      docker stop --time 60 "$OTCCLAW_CONTAINER" >/dev/null 2>&1 || true
    fi
  fi

  cleanup_unused_claimed_volumes

  if [[ "$phase" == "source_available" || "$phase" == "source_frozen" ]]; then
    printf 'Migration stopped before replacing the old PostgreSQL container; restarting containers that this script stopped.\n' >&2
    restart_stopped_containers
  else
    cat >&2 <<EOF
Migration stopped after the old PostgreSQL container was replaced.
OtcClaw will NOT be restarted automatically because the target may be empty or
partially restored.

Preserved recovery inputs:
  source database: $SOURCE_CONTAINER/$SOURCE_DATABASE
  source dump/reports: $backup_dir
  old Docker volumes: retained and not deleted
  target PGDATA: $PGDATA_DIR

Inspect the failure and choose either to repair/continue the fresh target or to
perform a manual rollback using the previous generated Compose and old volumes.
EOF
  fi
  exit "$status"
}
trap handle_exit EXIT

record_and_stop "$SESSION_AUDIT_CONTAINER"
record_and_stop "$OTCCLAW_CONTAINER"
phase="source_frozen"

active_connections="$(source_psql -Atc \
  "SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid();")"
[[ "$active_connections" == "0" ]] \
  || fail "source database still has $active_connections active client connection(s)"
source_write_stats_before="$(source_psql -AtF $'\t' -c \
  "SELECT tup_inserted, tup_updated, tup_deleted
   FROM pg_stat_database WHERE datname = current_database();")"

log "capturing frozen source baselines"
write_exact_counts source "$backup_dir/source-counts.tsv"
write_catalog_summary source "$backup_dir/source-catalog.tsv"
write_sequence_states source "$backup_dir/source-sequences.tsv"

log "dumping only $SOURCE_CONTAINER/$SOURCE_DATABASE"
docker exec "$SOURCE_CONTAINER" pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --serializable-deferrable \
  -U "$SOURCE_USER" \
  -d "$SOURCE_DATABASE" \
  >"$backup_dir/source-samata.dump"
[[ -s "$backup_dir/source-samata.dump" ]] || fail "source dump is empty"
sha256sum "$backup_dir/source-samata.dump" >"$backup_dir/source-samata.dump.sha256"
docker exec -i "$SOURCE_CONTAINER" pg_restore --list \
  <"$backup_dir/source-samata.dump" >"$backup_dir/source-samata.dump.list"
[[ -s "$backup_dir/source-samata.dump.list" ]] || fail "pg_restore could not list source dump"

write_exact_counts source "$backup_dir/source-counts-after-dump.tsv"
write_catalog_summary source "$backup_dir/source-catalog-after-dump.tsv"
write_sequence_states source "$backup_dir/source-sequences-after-dump.tsv"
diff -u "$backup_dir/source-counts.tsv" "$backup_dir/source-counts-after-dump.tsv"
diff -u "$backup_dir/source-catalog.tsv" "$backup_dir/source-catalog-after-dump.tsv"
diff -u "$backup_dir/source-sequences.tsv" "$backup_dir/source-sequences-after-dump.tsv"
active_connections="$(source_psql -Atc \
  "SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid();")"
[[ "$active_connections" == "0" ]] \
  || fail "a source client reconnected during dump ($active_connections active connection(s))"
source_write_stats_after="$(source_psql -AtF $'\t' -c \
  "SELECT tup_inserted, tup_updated, tup_deleted
   FROM pg_stat_database WHERE datname = current_database();")"
[[ "$source_write_stats_after" == "$source_write_stats_before" ]] \
  || fail "source insert/update/delete counters changed during dump; external writers are not frozen"

validate_pgdata_path
prepare_pgdata_directory
log "atomically claiming fresh Langfuse ClickHouse/MinIO volumes"
claim_fresh_volumes

local_container=""
for local_container in "${LANGFUSE_CONTAINERS[@]}"; do
  record_and_stop "$local_container"
done
record_and_stop "$TARGET_CONTAINER"

validate_pgdata_path
validate_claimed_fresh_volumes_unmounted
active_connections="$(source_psql -Atc \
  "SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid();")"
[[ "$active_connections" == "0" ]] \
  || fail "a source client reconnected before target replacement ($active_connections active connection(s))"
source_write_stats_after="$(source_psql -AtF $'\t' -c \
  "SELECT tup_inserted, tup_updated, tup_deleted
   FROM pg_stat_database WHERE datname = current_database();")"
[[ "$source_write_stats_after" == "$source_write_stats_before" ]] \
  || fail "source insert/update/delete counters changed before target replacement"
if container_is_running "$OTCCLAW_CONTAINER"; then
  fail "OtcClaw restarted during the migration; stop the concurrent deployment"
fi

log "replacing the old Langfuse PostgreSQL container without deleting its named volume"
phase="target_replacing"
if container_exists "$TARGET_CONTAINER"; then
  docker rm "$TARGET_CONTAINER" >/dev/null
fi
phase="target_replaced"

log "starting fresh PostgreSQL on $PGDATA_DIR"
compose up -d --no-build --no-deps "$TARGET_SERVICE"
wait_for_healthy_container "$TARGET_CONTAINER"
validate_target_mount

fresh_langfuse_tables="$(target_admin_psql langfuse -Atc \
  "SELECT count(*) FROM pg_tables
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")"
[[ "$fresh_langfuse_tables" == "0" ]] \
  || fail "fresh langfuse database unexpectedly contains $fresh_langfuse_tables user table(s)"

log "creating dedicated $TARGET_APP_USER/$TARGET_DATABASE"
compose run --rm --no-deps samata-postgres-init

target_tables="$(user_table_count target)"
[[ "$target_tables" == "0" ]] \
  || fail "target Samata database is not empty before restore ($target_tables tables)"

log "restoring Samata business data as $TARGET_APP_USER"
docker exec -i "$TARGET_CONTAINER" pg_restore \
  -U "$TARGET_ADMIN_USER" \
  -d "$TARGET_DATABASE" \
  --no-owner \
  --no-acl \
  --role="$TARGET_APP_USER" \
  --exit-on-error \
  <"$backup_dir/source-samata.dump"

log "comparing exact table rows, catalog totals, and sequence states"
write_exact_counts target "$backup_dir/target-counts.tsv"
write_catalog_summary target "$backup_dir/target-catalog.tsv"
write_sequence_states target "$backup_dir/target-sequences.tsv"
diff -u "$backup_dir/source-counts.tsv" "$backup_dir/target-counts.tsv"
diff -u "$backup_dir/source-catalog.tsv" "$backup_dir/target-catalog.tsv"
diff -u "$backup_dir/source-sequences.tsv" "$backup_dir/target-sequences.tsv"

non_app_owned_relations="$(target_admin_psql "$TARGET_DATABASE" -Atc \
  "SELECT count(*) FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg_toast%'
     AND c.relkind IN ('r', 'p', 'i', 'I', 'S', 'v', 'm', 'f')
     AND pg_get_userbyid(c.relowner) <> '$TARGET_APP_USER';")"
[[ "$non_app_owned_relations" == "0" ]] \
  || fail "$non_app_owned_relations restored relation(s) are not owned by $TARGET_APP_USER"

phase="target_verified"
log "removing stopped stateless Langfuse/OtcClaw containers; old data volumes remain untouched"
for local_container in "${LANGFUSE_CONTAINERS[@]}" "$SESSION_AUDIT_CONTAINER" "$OTCCLAW_CONTAINER"; do
  if container_exists "$local_container"; then
    docker rm -f "$local_container" >/dev/null
  fi
done

log "starting fresh Langfuse services"
validate_claimed_fresh_volumes_unmounted
compose up -d --no-build \
  langfuse-postgres \
  langfuse-clickhouse \
  langfuse-minio \
  langfuse-redis \
  langfuse-worker \
  langfuse-web

for local_container in \
  "$TARGET_CONTAINER" \
  "otcclaw-langfuse-clickhouse-server" \
  "otcclaw-langfuse-minio" \
  "otcclaw-langfuse-redis"; do
  wait_for_healthy_container "$local_container"
done
require_running_container "otcclaw-langfuse"
require_running_container "otcclaw-langfuse-worker"

log "starting OtcClaw only after the restored target and fresh Langfuse are ready"
phase="otcclaw_starting"
compose up -d --no-build otcclaw
wait_for_healthy_container "$OTCCLAW_CONTAINER"
phase="otcclaw_started"

log "starting the daily ticlaw/otcclaw session audit sidecar"
compose up -d --no-build session-audit
wait_for_healthy_container "$SESSION_AUDIT_CONTAINER"
wait_for_session_audit_completion

docker exec "$OTCCLAW_CONTAINER" sh -ec \
  'test "$LOG_PG_HOST" = "langfuse-postgres"
   test "$LOG_PG_PORT" = "5432"
   test "$LOG_PG_USER" = "samata_app"
   test "$LOG_PG_DB" = "samata"
   test -z "${WIND_PG_HOST+x}"
   test -z "${WIND_PG_PORT+x}"
   test -z "${WIND_PG_DATABASE+x}"
   test -z "${WIND_PG_USER+x}"
   test -z "${WIND_PG_PASSWORD+x}"'
docker exec -u node "$OTCCLAW_CONTAINER" sh -ec \
  'test ! -e /app/samata/data/postgres/PG_VERSION
   if touch /app/samata/data/postgres/.samata-write-probe 2>/dev/null; then
     rm -f /app/samata/data/postgres/.samata-write-probe
     exit 1
   fi'
docker exec "$SESSION_AUDIT_CONTAINER" sh -ec \
  'test "$SESSION_AUDIT_CRON" = "30 23 * * *"
   test "$SESSION_AUDIT_TIMEZONE" = "Asia/Chongqing"
   test "$SESSION_AUDIT_AGENTS" = "ticlaw,otcclaw"
   test "$SESSION_AUDIT_RUN_ON_START" = "1"
   test "$LOG_PG_HOST" = "langfuse-postgres"
   test "$LOG_PG_PORT" = "5432"
   test "$LOG_PG_USER" = "samata_app"
   test "$LOG_PG_DB" = "samata"'

target_admin_psql "$TARGET_DATABASE" -Atc \
  "SELECT current_database(), count(*) FROM pg_tables
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
   GROUP BY current_database();"

phase="complete"
cleanup_compose_snapshot
trap - EXIT
log "migration completed; source dump and verification reports: $backup_dir"
log "wind_sync_pg/samata and all legacy source/Langfuse data were retained"
