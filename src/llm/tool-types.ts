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
export type DeleteClientInput      = { name_or_id: string; dry_run?: boolean };
export type ImportPricingScheduleInput = { file_path: string; dry_run?: boolean };

// --- Trade ---
export type QueryTradesInput = { client?: string; party?: string; user?: string; date?: string; limit?: number };
export type PlotTradesInput  = { client?: string; party?: string; limit?: number };

// --- Knowledge ---
export type SearchKnowledgeInput        = { keyword: string };
export type ReadKnowledgeDocumentInput  = { document_id: string; max_chars?: number };
export type AddKnowledgeInput           = { question: string; answer: string; tags?: string; related_users?: string };
export type UpdateKnowledgeInput        = { id_prefix: string; fields: { question?: string; answer?: string; tags?: string; related_users?: string } };
export type DeleteKnowledgeInput        = { id_prefix: string };
export type AssignKnowledgeAgentInput   = { knowledge_id: string; agent_name: string };
export type UnassignKnowledgeAgentInput = { knowledge_id: string; agent_name: string };
export type GetKnowledgeAgentsInput     = { knowledge_id: string };
export type ListKnowledgeRecentInput   = { since?: string; until?: string; limit?: number };

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
export type WriteArtifactInput = { filename: string; content: string };
export type DownloadFileInput  = { url: string; filename?: string; headers?: Record<string, string>; timeout?: number };
export type SendFileInput      = { path: string };
export type SendImageInput     = { path: string };

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

// --- Wrong Question ---
export type WrongQuestionSubject = 'math' | 'chinese' | 'english' | 'science';
export type WrongQuestionErrorType = 'knowledge' | 'logic';
export type WrongQuestionSourceType = 'text' | 'image' | 'document';
export type RecordWrongQuestionInput = {
  subject: WrongQuestionSubject;
  question_summary: string;
  wrong_answer?: string;
  expected_direction?: string;
  error_type?: WrongQuestionErrorType;
  error_subtype?: string;
  analysis?: string;
  file_paths?: string[];
};
export type ListWrongQuestionsInput = {
  status?: 'open' | 'mastered' | 'all';
  subject?: WrongQuestionSubject;
  error_type?: WrongQuestionErrorType;
  limit?: number;
};
export type MarkWrongQuestionMasteredInput = { id: string };
export type WrongQuestionReportInput = {
  status?: 'open' | 'mastered' | 'all';
  subject?: WrongQuestionSubject;
  error_type?: WrongQuestionErrorType;
  limit?: number;
};

// --- Markdown ---
export type MarkdownToImageInput = {
  markdown: string;
  width?: number;
  theme?: 'light' | 'dark';
};

// --- Pricing Quote ---
export type ImportPricingQuoteInput = { file_path: string; quote_type?: string; dry_run?: boolean };
export type QueryPricingQuoteInput = { quote_type?: string; date?: string; currency?: string; tenor?: string; rate_type?: string };
export type ListPricingQuoteDatesInput = { quote_type?: string };

// --- Document ---
export type ImportDocumentInput = { file_path: string; title?: string; doc_date?: string };
export type DeleteDocumentInput = { id_prefix: string };

// --- Date ---
export type CalculateDateInput = {
  operation: 'shift' | 'diff' | 'is_trading_day' | 'now';
  date?: string;              // shift, is_trading_day
  days?: number;              // shift
  months?: number;            // shift
  years?: number;             // shift
  skip_non_trading?: boolean; // shift
  start_date?: string;        // diff
  end_date?: string;          // diff
  tz?: string;                // now
};

// --- Media Generation ---
export type GenerateImageInput = {
  prompt: string;
  aspect_ratio?: string;
  count?: number;
  reference_image?: string;
};
export type GenerateVideoInput = {
  prompt: string;
  duration?: number;
  resolution?: string;
  first_frame_image?: string;
};

// --- Scheduled Tasks ---
export type CreateScheduledTaskInput = {
  name: string;
  cron_expr: string;
  task_type: 'remind' | 'sandbox_exec' | 'tool_call';
  payload: string;
  timezone?: string;
};
export type UpdateScheduledTaskInput = {
  id: string;
  enabled?: boolean;
  cron_expr?: string;
  name?: string;
  payload?: string;
  timezone?: string;
};
export type DeleteScheduledTaskInput = { id: string };

// --- System Crontab ---
export type AddCrontabInput = {
  cron_expr: string;
  command: string;
  comment?: string;
};
export type RemoveCrontabInput = {
  pattern: string;
};
