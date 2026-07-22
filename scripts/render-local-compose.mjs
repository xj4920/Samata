#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_SOURCE = resolve(REPO_ROOT, 'docker-compose.yml');
const DEFAULT_OUTPUT = '/opt/samata/docker-compose.yml';
const PLACEHOLDER_PATTERN = /\{\{string\s+"([A-Za-z_][A-Za-z0-9_]*)"\}\}/g;

function usage() {
  return `Usage: node scripts/render-local-compose.mjs [options]

Options:
  --source <path>       Source template (default: ${DEFAULT_SOURCE})
  --output <path>       Generated compose (default: ${DEFAULT_OUTPUT})
  --env-file <path>     Render input; repeatable (defaults: .env and .env.langfuse)
  --docker-repo <repo>  Value for {{string "docker_repo"}}
  --image-version <tag> Value for {{string "image_version"}}
  --skip-validation     Skip docker compose config validation (tests only)
  -h, --help            Show help
`;
}

export function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    envFiles: [],
    dockerRepo: undefined,
    imageVersion: undefined,
    skipValidation: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ...options, help: true };
    if (arg === '--skip-validation') {
      options.skipValidation = true;
      continue;
    }
    if (!['--source', '--output', '--env-file', '--docker-repo', '--image-version'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    i += 1;
    if (arg === '--source') options.source = value;
    if (arg === '--output') options.output = value;
    if (arg === '--env-file') options.envFiles.push(value);
    if (arg === '--docker-repo') options.dockerRepo = value;
    if (arg === '--image-version') options.imageVersion = value;
  }

  if (options.envFiles.length === 0) {
    options.envFiles = [resolve(REPO_ROOT, '.env'), resolve(REPO_ROOT, '.env.langfuse')];
  }
  return options;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function resolveInputPath(inputPath) {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(REPO_ROOT, inputPath);
}

function scalarFragment(value, name) {
  if (/[\r\n\u0000]/u.test(value)) {
    throw new Error(`Parameter ${name} contains an unsupported newline or NUL byte`);
  }
  // The source template quotes placeholders with YAML single quotes. Escape for
  // that scalar and double '$' so Docker Compose passes a literal dollar sign.
  return value.replaceAll("'", "''").replaceAll('$', () => '$$');
}

function detectHostIp() {
  const explicitHost = process.env.SAMATA_HOST_IP?.trim();
  if (explicitHost) return explicitHost;

  const hostnameResult = spawnSync('hostname', ['-I'], { encoding: 'utf8' });
  if (hostnameResult.status === 0) {
    const candidate = hostnameResult.stdout
      .trim()
      .split(/\s+/u)
      .find(address => /^[0-9.]+$/u.test(address) && !address.startsWith('127.'));
    if (candidate) return candidate;
  }

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('127.')) {
        return address.address;
      }
    }
  }

  throw new Error('NEXTAUTH_URL is missing and the container host IP could not be detected');
}

function applyDefaultValues(values) {
  if (values.NEXTAUTH_URL == null || values.NEXTAUTH_URL === '') {
    values.NEXTAUTH_URL = `http://${detectHostIp()}:3001`;
  }
  return values;
}

export function collectPlaceholderNames(template) {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1]);
}

export function renderComposeTemplate(template, values) {
  const missing = [...new Set(collectPlaceholderNames(template))]
    .filter(name => values[name] == null || values[name] === '');
  if (missing.length > 0) {
    throw new Error(`Missing required template parameters: ${missing.sort().join(', ')}`);
  }

  const rendered = template.replace(PLACEHOLDER_PATTERN, (_token, name) =>
    scalarFragment(String(values[name]), name));

  if (/\{\{string\s+"/u.test(rendered)) {
    throw new Error('Unresolved template placeholders remain after rendering');
  }
  return rendered;
}

async function loadEnvFiles(envFiles) {
  const values = {};
  for (const envFile of envFiles) {
    const filePath = resolveInputPath(envFile);
    try {
      const parsed = dotenv.parse(await readFile(filePath));
      Object.assign(values, parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return values;
}

function validateCompose(composePath) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', '/dev/null', '--file', composePath, 'config', '--quiet'],
    { cwd: dirname(composePath), encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`docker compose config validation failed${detail ? `: ${detail}` : ''}`);
  }
}

async function assertWritableDirectory(outputDir) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await access(outputDir, fsConstants.W_OK);
}

export async function renderLocalCompose(rawOptions) {
  const source = resolveInputPath(rawOptions.source);
  const output = resolveInputPath(rawOptions.output);
  if (source === output) {
    throw new Error('Refusing to overwrite the source docker-compose.yml template');
  }

  const sourceBefore = await readFile(source, 'utf8');
  const sourceHash = sha256(sourceBefore);
  const envValues = await loadEnvFiles(rawOptions.envFiles);
  const values = {
    ...envValues,
    ...process.env,
    docker_repo:
      rawOptions.dockerRepo
      ?? process.env.DOCKER_REPO
      ?? envValues.DOCKER_REPO
      ?? process.env.docker_repo
      ?? envValues.docker_repo,
    image_version:
      rawOptions.imageVersion
      ?? process.env.IMAGE_VERSION
      ?? envValues.IMAGE_VERSION
      ?? process.env.OTCCLAW_IMAGE_TAG
      ?? envValues.OTCCLAW_IMAGE_TAG
      ?? process.env.image_version
      ?? envValues.image_version,
  };
  applyDefaultValues(values);

  const rendered = [
    '# GENERATED FILE — DO NOT EDIT.',
    `# Source: ${relative(dirname(output), source) || source}`,
    sourceBefore,
  ].join('\n');
  const finalContent = renderComposeTemplate(rendered, values);

  const outputDir = dirname(output);
  await assertWritableDirectory(outputDir);
  const temporary = `${output}.tmp-${process.pid}`;
  const backup = `${output}.previous`;

  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(finalContent, 'utf8');
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    if (!rawOptions.skipValidation) validateCompose(temporary);

    const sourceAfter = await readFile(source, 'utf8');
    if (sha256(sourceAfter) !== sourceHash) {
      throw new Error('Source docker-compose.yml changed during rendering');
    }

    try {
      const current = await stat(output);
      if (current.isFile()) await copyFile(output, backup);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return { source, output, parameterCount: new Set(collectPlaceholderNames(sourceBefore)).size };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await renderLocalCompose(options);
    process.stdout.write(
      `Generated ${result.output} from ${result.source} (${result.parameterCount} parameters).\n`,
    );
  } catch (error) {
    process.stderr.write(`Compose rendering failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
