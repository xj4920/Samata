#!/usr/bin/env node

import fs from 'node:fs';

const path = '/app/samata/logs/daily_usage/.session-audit-heartbeat.json';
const maxAgeMs = 36 * 60 * 60 * 1000;

try {
  const heartbeat = JSON.parse(fs.readFileSync(path, 'utf8'));
  const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
  const healthy = heartbeat.status !== 'failed'
    && Number.isFinite(age)
    && age >= 0
    && age <= maxAgeMs;
  process.exit(healthy ? 0 : 1);
} catch {
  process.exit(1);
}
