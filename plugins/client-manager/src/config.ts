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

export function loadCustomers(): Customer[] {
  if (cached) return cached;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const file = resolve(__dirname, '../config/customers.json');
  cached = JSON.parse(readFileSync(file, 'utf-8')) as Customer[];
  return cached;
}
