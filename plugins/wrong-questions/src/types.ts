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

export interface WrongQuestion {
  id: string;
  agent_id: string;
  user_id: string;
  subject: WrongQuestionSubject;
  question_summary: string;
  wrong_answer: string | null;
  expected_direction: string | null;
  error_type: WrongQuestionErrorType;
  error_subtype: string | null;
  analysis: string | null;
  status: 'open' | 'mastered';
  mistake_count: number;
  source_type: WrongQuestionSourceType;
  storage_dir: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_wrong_at: string;
  mastered_at: string | null;
}

export interface WrongQuestionAsset {
  id: string;
  wrong_question_id: string;
  asset_role: 'original' | 'annotated' | 'cropped' | 'ocr';
  file_name: string;
  file_ext: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  stored_path: string;
  created_at: string;
}
