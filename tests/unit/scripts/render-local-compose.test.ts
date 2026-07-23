import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import {
  collectPlaceholderNames,
  renderComposeTemplate,
  renderLocalCompose,
} from '../../../scripts/render-local-compose.mjs';

const originalDockerRepo = process.env.DOCKER_REPO;
const originalImageVersion = process.env.IMAGE_VERSION;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;
const originalSamataHostIp = process.env.SAMATA_HOST_IP;
const EXPECTED_PLACEHOLDERS = [
  'CLICKHOUSE_PASSWORD',
  'CUSTOM_API_KEY',
  'CUSTOM_BASE_URL',
  'CUSTOM_MODEL',
  'CUSTOM_VISION_MODEL',
  'ENCRYPTION_KEY',
  'HEDGE_RATIO_EMAIL_ADDRESS',
  'HEDGE_RATIO_EMAIL_IMAP_PORT',
  'HEDGE_RATIO_EMAIL_IMAP_SERVER',
  'HEDGE_RATIO_EMAIL_PASSWORD',
  'LANGFUSE_INIT_USER_PASSWORD',
  'LANGFUSE_POSTGRES_PASSWORD',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LOGYI_API_KEY',
  'MINIO_ROOT_PASSWORD',
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
  'REDIS_AUTH',
  'SALT',
  'SAMATA_POSTGRES_PASSWORD',
  'SERPER_API_KEY',
  'SFTP_HOST',
  'SFTP_PASSWORD',
  'SFTP_USER',
  'docker_repo',
  'image_version',
];

afterEach(() => {
  if (originalDockerRepo === undefined) delete process.env.DOCKER_REPO;
  else process.env.DOCKER_REPO = originalDockerRepo;
  if (originalImageVersion === undefined) delete process.env.IMAGE_VERSION;
  else process.env.IMAGE_VERSION = originalImageVersion;
  if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  if (originalSamataHostIp === undefined) delete process.env.SAMATA_HOST_IP;
  else process.env.SAMATA_HOST_IP = originalSamataHostIp;
});

describe('local compose renderer', () => {
  it('locks the production template to the 27 approved parameters', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const placeholders = [...new Set(collectPlaceholderNames(template))].sort();

    expect(placeholders).toEqual(EXPECTED_PLACEHOLDERS);
    expect(placeholders).toHaveLength(27);
    for (const removedName of [
      'WIND_PG_HOST',
      'WIND_PG_PORT',
      'WIND_PG_DATABASE',
      'WIND_PG_USER',
      'WIND_PG_PASSWORD',
      'TELEGRAM_ADMIN_IDS',
      'FEISHU_ADMIN_IDS',
      'DREAM_PROVIDER',
      'DREAM_MODEL',
    ]) {
      expect(placeholders).not.toContain(removedName);
    }
  });

  it('keeps one shared SFTP host, user, and password as deployment inputs', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const sftpInputs = [...new Set(
      collectPlaceholderNames(template).filter(name => name.startsWith('SFTP_')),
    )].sort();

    expect(sftpInputs).toEqual(['SFTP_HOST', 'SFTP_PASSWORD', 'SFTP_USER']);
    for (const runtimeKey of [
      'SFTP_HOST',
      'SFTP_PORT',
      'SFTP_USER',
      'SFTP_PASSWORD',
      'SFTP_FAST_TRADES_REMOTE_BASE',
      'SFTP_NORMAL_TRADES_REMOTE_BASE',
      'SFTP_NORMAL_SUMMARY_REMOTE_BASE',
      'SFTP_NORMAL_POSITION_DETAILS_REMOTE_BASE',
      'SFTP_FAST_SUMMARY_REMOTE_BASE',
      'SFTP_CORPORATE_ACTION_REMOTE_BASE',
      'SFTP_SBL_REMOTE_BASE',
      'SFTP_HEDGE_ENABLED',
      'SFTP_HEDGE_REMOTE_BASE',
    ]) {
      expect(template).toMatch(new RegExp(`^\\s+${runtimeKey}:`, 'm'));
    }
    expect(template).toContain("SFTP_HOST: '{{string \"SFTP_HOST\"}}'");
    expect(template).toContain("SFTP_PORT: '22'");
    expect(template).toContain("SFTP_USER: '{{string \"SFTP_USER\"}}'");
    expect(template).toContain("SFTP_FAST_TRADES_REMOTE_BASE: '/EQDHK_internal/data/FastTrading/trades'");
    expect(template).toContain("SFTP_NORMAL_TRADES_REMOTE_BASE: '/EQDHK_internal/data/NormalTrading/trades'");
    expect(template).toContain("SFTP_NORMAL_SUMMARY_REMOTE_BASE: '/EQDHK_internal/data/NormalTrading/summary'");
    expect(template).toContain("SFTP_NORMAL_POSITION_DETAILS_REMOTE_BASE: '/EQDHK_internal/data/NormalTrading/details'");
    expect(template).toContain("SFTP_FAST_SUMMARY_REMOTE_BASE: '/EQDHK_internal/data/FastTrading/summary'");
    expect(template).toContain("SFTP_CORPORATE_ACTION_REMOTE_BASE: '/EQDHK_internal/data/CorporateActionAlert'");
    expect(template).toContain("SFTP_SBL_REMOTE_BASE: '/EQDHK_internal/data/SBL'");
    expect(template).toContain("SFTP_HEDGE_REMOTE_BASE: '/EQDHK_internal/data/QFII/'");
    expect(template).not.toMatch(
      /\{\{string "(?:NORMAL_TRADING_SFTP|FAST_TRADING_SFTP|CORPACTIONSFTP|CORP_ACTION_SFTP|SBL_SFTP|HEDGE_RATIO_SFTP)_/,
    );
    expect(template).not.toMatch(
      /^\s+(?:NORMAL_TRADING_SFTP|FAST_TRADING_SFTP|CORPACTIONSFTP|CORP_ACTION_SFTP|SBL_SFTP|HEDGE_RATIO_SFTP)_/m,
    );
  });

  it('fixes the production tool deny list and maps one LogYi key to both MCPs', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(template).toContain("SAMATA_DISABLED_TOOLS: 'generate_image,generate_video'");
    expect(template).not.toContain(
      "SAMATA_DISABLED_TOOLS: 'generate_image,generate_video,analyze_sbl_usage'",
    );
    expect(template.match(/\{\{string "LOGYI_API_KEY"\}\}/g)).toHaveLength(2);
    expect(template).toContain("TICLAW_LOGYI_API_KEY: '{{string \"LOGYI_API_KEY\"}}'");
    expect(template).toContain("OTCMSCLAW_LOGYI_API_KEY: '{{string \"LOGYI_API_KEY\"}}'");
  });

  it('keeps analyze_sbl_usage on SFTP CSV data without a Wind database dependency', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const compose = parseYaml(template);
    const otcclaw = compose.services.otcclaw;

    for (const name of [
      'WIND_PG_HOST',
      'WIND_PG_PORT',
      'WIND_PG_DATABASE',
      'WIND_PG_USER',
      'WIND_PG_PASSWORD',
    ]) {
      expect(otcclaw.environment).not.toHaveProperty(name);
    }
    expect(otcclaw.environment).toMatchObject({
      SFTP_HOST: '{{string "SFTP_HOST"}}',
      SFTP_PORT: '22',
      SFTP_USER: '{{string "SFTP_USER"}}',
      SFTP_PASSWORD: '{{string "SFTP_PASSWORD"}}',
      SFTP_SBL_REMOTE_BASE: '/EQDHK_internal/data/SBL',
    });
    expect(otcclaw.depends_on).not.toHaveProperty('sbl-wind-check');
    expect(compose.services).not.toHaveProperty('sbl-wind-check');
    expect(compose.services).not.toHaveProperty('wind_sync_pg');
    expect(compose.networks ?? {}).not.toHaveProperty('wind-sync');
    expect(otcclaw.networks ?? []).not.toContain('wind-sync');
    expect(otcclaw.healthcheck.test.join(' ')).toContain('/health');
    expect(template).not.toMatch(/WIND_PG|wind_sync|wind-sync|sbl-wind/);
  });


  it('keeps example render inputs in exact 16 + 10 parity with the template', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const samataInputs = dotenv.parse(await readFile(join(process.cwd(), '.env.example')));
    const langfuseInputs = dotenv.parse(await readFile(join(process.cwd(), '.env.langfuse.example')));

    expect(Object.keys(samataInputs)).toHaveLength(16);
    expect(Object.keys(langfuseInputs)).toHaveLength(10);

    const mappedInputs = [
      ...Object.keys(samataInputs),
      ...Object.keys(langfuseInputs),
      'NEXTAUTH_URL',
    ].map(name => {
      if (name === 'DOCKER_REPO') return 'docker_repo';
      if (name === 'IMAGE_VERSION') return 'image_version';
      return name;
    }).sort();

    expect(mappedInputs).toEqual(EXPECTED_PLACEHOLDERS);
    expect([...new Set(collectPlaceholderNames(template))].sort()).toEqual(mappedInputs);
  });

  it('defaults NEXTAUTH_URL to the container host IP and port 3001', async () => {
    delete process.env.NEXTAUTH_URL;
    process.env.SAMATA_HOST_IP = '10.49.9.185';
    const root = await mkdtemp(join(tmpdir(), 'samata-compose-nextauth-'));
    const source = join(root, 'source.yml');
    const output = join(root, 'runtime', 'docker-compose.yml');
    const envFile = join(root, '.env');
    await writeFile(source, "NEXTAUTH_URL: '{{string \"NEXTAUTH_URL\"}}'\n");
    await writeFile(envFile, '');

    await renderLocalCompose({
      source,
      output,
      envFiles: [envFile],
      dockerRepo: undefined,
      imageVersion: undefined,
      skipValidation: true,
    });

    expect(await readFile(output, 'utf8')).toContain("NEXTAUTH_URL: 'http://10.49.9.185:3001'");
  });

  it('publishes Langfuse web on all host interfaces', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const compose = parseYaml(template);

    expect(compose.services['langfuse-web'].ports)
      .toContain('0.0.0.0:3001:3000');
  });

  it('captures trace content without uploading the system prompt', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const compose = parseYaml(template);

    expect(compose.services.otcclaw.environment).toMatchObject({
      LANGFUSE_CAPTURE_CONTENT: 'true',
      LANGFUSE_CAPTURE_SYSTEM_PROMPT: 'false',
    });
  });

  it('uses fresh Langfuse storage and shields PostgreSQL from OtcClaw', async () => {
    const template = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const compose = parseYaml(template);
    const postgresMount = compose.services['langfuse-postgres'].volumes
      .find((volume: { target?: string }) => volume.target === '/var/lib/postgresql/data');
    const guard = compose.services.otcclaw.volumes
      .find((volume: { target?: string }) => volume.target === '/app/samata/data/postgres');

    expect(postgresMount).toMatchObject({
      type: 'bind',
      source: '/opt/samata/data/postgres',
      target: '/var/lib/postgresql/data',
      bind: { create_host_path: false },
    });
    expect(guard).toMatchObject({
      type: 'volume',
      target: '/app/samata/data/postgres',
      read_only: true,
      volume: { nocopy: true },
    });
    expect(compose.volumes.langfuse_clickhouse_data.name)
      .toBe('otcclaw_prod_langfuse_clickhouse_data_v1');
    expect(compose.volumes.langfuse_clickhouse_logs.name)
      .toBe('otcclaw_prod_langfuse_clickhouse_logs_v1');
    expect(compose.volumes.langfuse_minio_data.name)
      .toBe('otcclaw_prod_langfuse_minio_data_v1');
    expect(compose.services['langfuse-minio'].entrypoint).toEqual(['sh', '-ec']);
    expect(compose.services['langfuse-minio'].command).toEqual([
      'mkdir -p /data/langfuse && exec minio server --address ":9000" --console-address ":9001" /data',
    ]);
    expect(template).not.toContain('samata_langfuse_postgres_data');
  });

  it('keeps the migration fresh-target only and cleans only unused volumes claimed by this run', async () => {
    const script = await readFile(
      join(process.cwd(), 'scripts/migrate-samata-postgres.sh'),
      'utf8',
    );

    expect(script).toContain('SOURCE_DATABASE="samata"');
    expect(script).toContain('PGDATA_DIR=');
    expect(script).toContain('--serializable-deferrable');
    expect(script).not.toContain('target-langfuse.dump');
    expect(script).not.toMatch(/pg_dump[^\n]*-d\s+langfuse/);
    expect(script).toContain("n.nspname NOT LIKE 'pg_toast%'");
    expect(script.match(/docker volume rm/g)).toHaveLength(1);
    expect(script).toContain('cleanup_unused_claimed_volumes');
    expect(script).toContain('com.samata.postgres-migration-claim');
    expect(script.indexOf('claimed_fresh_volumes+=("$volume")'))
      .toBeLessThan(script.indexOf('docker volume create'));
    expect(script).toContain('if [[ "$actual_claim" == "$fresh_volume_claim" ]]');
    expect(script).toContain('docker ps -aq --filter "volume=$volume"');
    expect(script).toContain('validate_claimed_fresh_volumes_unmounted');
    expect(script).toContain('flock -n 9');
    expect(script.indexOf('phase="target_replacing"'))
      .toBeLessThan(script.indexOf('docker rm "$TARGET_CONTAINER"'));
    const claimInvocation = script.indexOf('\nclaim_fresh_volumes\n');
    expect(claimInvocation).toBeLessThan(script.indexOf('phase="target_replacing"'));
    const validateClaimInvocation = script.lastIndexOf(
      '\nvalidate_claimed_fresh_volumes_unmounted\n',
    );
    expect(validateClaimInvocation).toBeLessThan(script.indexOf(
      'compose up -d --no-build \\\n  langfuse-postgres',
    ));
    expect(script).not.toContain('down -v');
    expect(script).not.toContain('docker volume prune');
    expect(script).not.toMatch(/docker volume rm[^\n]*samata_langfuse_/);
    expect(script).not.toContain('SBL_WIND_PROVISION_SCRIPT');
    expect(script).not.toContain('SBL_WIND_CHECK_SCRIPT');
    expect(script).toContain("if (services['sbl-wind-check']) fail");
    expect(script).toContain("if (source.networks?.['wind-sync'])");
    expect(script).toContain('test -z "${WIND_PG_PASSWORD+x}"');
    expect(script).toContain('wait_for_healthy_container "$OTCCLAW_CONTAINER"');
    expect(script).toContain('Stopping OtcClaw because a final deployment gate failed.');
    expect(script).not.toContain('record_and_stop "$SOURCE_CONTAINER"');
    expect(script).not.toContain('docker rm "$SOURCE_CONTAINER"');
    expect(script).not.toMatch(/pg_dump[^\n]*-d\s+wind_sync/);
    expect(script).not.toContain('docker network rm');
  });

  it('coordinates official render/deploy/migration entrypoints and snapshots Compose', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    const migration = await readFile(
      join(process.cwd(), 'scripts/migrate-samata-postgres.sh'),
      'utf8',
    );
    const deploy = await readFile(
      join(process.cwd(), 'scripts/deploy-otcclaw.sh'),
      'utf8',
    );
    const dockerSamata = await readFile(
      join(process.cwd(), 'scripts/docker-samata.sh'),
      'utf8',
    );

    expect(packageJson.scripts['compose:render'])
      .toBe('bash scripts/deploy-otcclaw.sh render');
    expect(migration).toContain('DEPLOY_LOCK_TARGET="$DEPLOY_ROOT"');
    expect(migration).toContain('exec 9<"$DEPLOY_LOCK_TARGET"');
    expect(migration).toContain('create_compose_snapshot');
    expect(migration).toContain('COMPOSE_FILE="$COMPOSE_SNAPSHOT"');
    expect(migration).toContain('--project-name samata');
    expect(migration).toContain('if rm -f -- "$snapshot"; then');
    expect(migration).toContain('Warning: could not remove Compose snapshot');
    expect(migration).not.toContain('MIGRATION_LOCK_FILE="/tmp/');
    expect(deploy).toContain('exec 9<"$deploy_root"');
    expect(deploy).not.toContain(
      'Direct operation:\n  cd $deploy_root\n  docker compose --env-file /dev/null config --quiet\n  docker compose --env-file /dev/null up',
    );
    expect(dockerSamata).toContain('exec 9<"$deploy_root"');
    expect(dockerSamata.lastIndexOf('\n  acquire_deploy_lock\n'))
      .toBeLessThan(dockerSamata.indexOf('node scripts/render-local-compose.mjs'));

    const targetReplacement = migration.indexOf('\nphase="target_replacing"\n');
    const finalClaimCheck = migration.lastIndexOf(
      '\nvalidate_claimed_fresh_volumes_unmounted\n',
      targetReplacement,
    );
    const finalSourceCheck = migration.lastIndexOf(
      'a source client reconnected before target replacement',
    );
    expect(finalClaimCheck).toBeLessThan(finalSourceCheck);
    expect(finalSourceCheck).toBeLessThan(targetReplacement);
  });

  it('reports missing names without exposing values', () => {
    const template = "image: '{{string \"docker_repo\"}}/{{string \"image_version\"}}'\n";
    expect(collectPlaceholderNames(template)).toEqual(['docker_repo', 'image_version']);
    expect(() => renderComposeTemplate(template, { docker_repo: 'registry.example.com' }))
      .toThrow('image_version');
  });

  it('escapes YAML quotes and Docker Compose dollar interpolation', () => {
    const template = "SECRET: '{{string \"SECRET\"}}'\n";
    expect(renderComposeTemplate(template, { SECRET: "a'b$c" }))
      .toBe("SECRET: 'a''b$$c'\n");
  });

  it('atomically writes a generated file and leaves the source template unchanged', async () => {
    delete process.env.DOCKER_REPO;
    delete process.env.IMAGE_VERSION;
    const root = await mkdtemp(join(tmpdir(), 'samata-compose-render-'));
    const source = join(root, 'source.yml');
    const output = join(root, 'runtime', 'docker-compose.yml');
    const envFile = join(root, '.env');
    const template = [
      'services:',
      '  app:',
      '    image: \'{{string "docker_repo"}}/app:{{string "image_version"}}\'',
      '    environment:',
      '      SECRET: \'{{string "SECRET"}}\'',
      '',
    ].join('\n');
    await writeFile(source, template);
    await writeFile(envFile, 'DOCKER_REPO=registry.example.com\nIMAGE_VERSION=v1\nSECRET=value\n');

    const result = await renderLocalCompose({
      source,
      output,
      envFiles: [envFile],
      dockerRepo: undefined,
      imageVersion: undefined,
      skipValidation: true,
    });

    expect(result.output).toBe(output);
    expect(await readFile(source, 'utf8')).toBe(template);
    expect(await readFile(output, 'utf8')).toContain('registry.example.com/app:v1');
    expect(await readFile(output, 'utf8')).toContain('# GENERATED FILE — DO NOT EDIT.');
  });

  it('refuses to overwrite the source template', async () => {
    const root = await mkdtemp(join(tmpdir(), 'samata-compose-collision-'));
    const source = join(root, 'docker-compose.yml');
    await writeFile(source, "KEY: '{{string \"KEY\"}}'\n");

    await expect(renderLocalCompose({
      source,
      output: source,
      envFiles: [],
      dockerRepo: undefined,
      imageVersion: undefined,
      skipValidation: true,
    })).rejects.toThrow('Refusing to overwrite');
  });
});
