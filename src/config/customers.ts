import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const file = resolve(process.cwd(), 'config/customers.json');
  cached = JSON.parse(readFileSync(file, 'utf-8')) as Customer[];
  return cached;
}
