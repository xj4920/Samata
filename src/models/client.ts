export const STATES = [
  'initial_contact',
  'requirement_discussion',
  'solution_design',
  'uat',
  'prod',
] as const;

export type ClientState = typeof STATES[number];

export const STATE_LABELS: Record<ClientState, string> = {
  initial_contact: 'Initial Contact',
  requirement_discussion: 'Requirement Discussion',
  solution_design: 'Solution Design',
  uat: 'UAT',
  prod: 'PROD',
};

export const STATE_PRIORITY = Object.fromEntries(
  STATES.map((s, i) => [s, i])
) as Record<ClientState, number>;

export function nextState(current: ClientState): ClientState | null {
  const idx = STATES.indexOf(current);
  if (idx < 0 || idx >= STATES.length - 1) return null;
  return STATES[idx + 1];
}

export function prevState(current: ClientState): ClientState | null {
  const idx = STATES.indexOf(current);
  if (idx <= 0) return null;
  return STATES[idx - 1];
}

export type ClientCategory = '多空客户' | '中性客户';

export function classifyClient(isFt: boolean, shortFinancing: number | null): ClientCategory | null {
  if (!isFt) return null;
  return shortFinancing !== null && shortFinancing !== undefined ? '中性客户' : '多空客户';
}

export interface Client {
  id: string;
  name: string;
  contact: string | null;
  state: ClientState;
  wework_group: string | null;
  requirements: string | null;
  sales: string | null;
  tags: string | null;
  notes: string | null;
  long_financing_spread: number | null;
  short_financing: number | null;
  commission: number | null;
  commission_cost: number | null;
  net_comm: number | null;
  index_hedging: number | null;
  pricing_range: string | null;
  is_ft: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
