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

export function nextState(current: ClientState): ClientState | null {
  const idx = STATES.indexOf(current);
  if (idx < 0 || idx >= STATES.length - 1) return null;
  return STATES[idx + 1];
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
  created_by: string;
  created_at: string;
  updated_at: string;
}
