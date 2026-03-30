/**
 * Shared input types for all tool handlers.
 *
 * These types are the single source of truth for tool parameter names.
 * Both the tool definition (input_schema) and the handler function signature
 * must reference these types, so a parameter rename shows up as a TS error.
 */

// --- Client ---
export type QueryClientsInput      = { state?: string; keyword?: string };
export type ViewClientInput        = { name_or_id: string };
export type GetClientHistoryInput  = { name_or_id: string };
export type AddClientInput         = { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string };
export type UpdateClientInput      = { name_or_id: string; fields: Record<string, string> };
export type AdvanceClientInput     = { name_or_id: string };
export type RollbackClientInput    = { name_or_id: string };

// --- Trade ---
export type QueryTradesInput = { client?: string; party?: string; user?: string; date?: string; limit?: number };
export type PlotTradesInput  = { client?: string; party?: string; limit?: number };

// --- Knowledge ---
export type SearchKnowledgeInput        = { keyword: string };
export type AddKnowledgeInput           = { question: string; answer: string; tags?: string; related_users?: string };
export type UpdateKnowledgeInput        = { id_prefix: string; fields: { question?: string; answer?: string; tags?: string; related_users?: string } };
export type DeleteKnowledgeInput        = { id_prefix: string };
export type AssignKnowledgeAgentInput   = { knowledge_id: string; agent_name: string };
export type UnassignKnowledgeAgentInput = { knowledge_id: string; agent_name: string };
export type GetKnowledgeAgentsInput     = { knowledge_id: string };

// --- Skill ---
export type GetSkillInput    = { name: string };
export type SaveSkillInput   = { name: string; prompt: string; scope?: string };
export type DeleteSkillInput = { name: string };

// --- File / System ---
export type ListDirectoryInput = { path: string };
export type ReadFileInput      = { path: string; max_lines?: number };
export type WriteFileInput     = { path: string; content: string };
export type EditFileInput      = { path: string; old_text: string; new_text: string };
export type ExecCmdInput       = { cmd: string; timeout_ms?: number };

// --- WeworkQA ---
export type ExtractWeworkQAInput = {
  topics?: string[];
  people?: string[];
  start_date?: string;
  end_date?: string;
  session?: string;
  limit?: number;
};

// --- Agent ---
export type GetAgentInput     = { name: string };
export type SaveAgentInput    = {
  name: string;
  display_name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  provider?: string;
  tools_mode?: string;
  tools_list?: string[];
  max_history?: number;
  preset?: string;
};
export type DeleteAgentInput  = { name: string };
export type SwitchAgentInput  = { name: string };
export type AssignAgentInput  = { agent_name: string; channel: string; app_id?: string; target_id?: string };
export type UnassignAgentInput = { channel: string; app_id?: string; target_id?: string };

// --- Memory ---
export type SaveMemoryInput   = { content: string; scope?: string; category?: string };
export type SearchMemoryInput = { keyword: string };
export type DeleteMemoryInput = { id: string };
export type UpdateMemoryInput = { id: string; content?: string; category?: string };

// --- HTTP ---
export type HttpRequestInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
};

// --- Reminder ---
export type SetReminderInput = {
  message: string;
  remind_at?: string;      // ISO8601 datetime string
  delay_minutes?: number;  // alternative: relative delay
};
export type CancelReminderInput = { id: string };

// --- Todo ---
export type CreateTodoInput = {
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high';
  due_date?: string;  // YYYY-MM-DD
  tags?: string[];
};
export type ListTodosInput = {
  status?: 'pending' | 'in_progress' | 'done' | 'all';
  priority?: 'low' | 'normal' | 'high';
};
export type UpdateTodoInput = {
  id: string;
  title?: string;
  description?: string;
  status?: 'pending' | 'in_progress' | 'done';
  priority?: 'low' | 'normal' | 'high';
  due_date?: string;
  tags?: string[];
};
export type DeleteTodoInput = { id: string };
