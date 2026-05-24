import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Product {
  user_id: string;
  counter_party: string;
}

export interface Customer {
  name: string;
  sales: string;
  products: Product[];
}

let cached: Customer[] | null = null;
let configDir: string | null = null;

export function setConfigDir(dir: string): void {
  configDir = dir;
  cached = null;
}

export function loadCustomers(): Customer[] {
  if (cached) return cached;

  const searchPaths = [
    configDir ? resolve(configDir, 'customers.json') : null,
    resolve(process.cwd(), 'config/customers.json'),
  ].filter(Boolean) as string[];

  for (const file of searchPaths) {
    try {
      cached = JSON.parse(readFileSync(file, 'utf-8')) as Customer[];
      return cached;
    } catch { /* try next */ }
  }

  cached = [];
  return cached;
}
