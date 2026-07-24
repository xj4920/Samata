import type { AssertionResult, CapturedToolCall, ScenarioAssertions, ScenarioRisk, ScenarioRunStatus } from './types.js';

export type LiveCaseStatus = 'draft' | 'approved' | 'quarantined' | 'deprecated';
export type LiveTarget = 'staging' | 'production';
export type LiveSafetyLevel = 'read_only' | 'sandbox' | 'controlled_delivery';
export type LiveValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface LiveReview {
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
}

export interface LivePathTypeAssertion {
  path: string;
  type: LiveValueType;
}

export interface LivePathValueAssertion {
  path: string;
  value: unknown;
}

export interface LivePathRegexAssertion {
  path: string;
  pattern: string;
}

export type LiveOperand =
  | { path: string }
  | { value: number | string | boolean | null };

export type LiveInvariant =
  | { op: 'gte' | 'lte' | 'eq'; left: LiveOperand; right: LiveOperand }
  | {
      op: 'approx_ratio';
      result: LiveOperand;
      numerator: LiveOperand;
      denominator: LiveOperand;
      tolerance?: number;
    }
  | { op: 'date_order'; start: LiveOperand; end: LiveOperand };

export interface LiveOutputAssertions {
  expectSuccess?: boolean;
  requiredPaths?: string[];
  types?: LivePathTypeAssertion[];
  equals?: LivePathValueAssertion[];
  contains?: LivePathValueAssertion[];
  matches?: LivePathRegexAssertion[];
  forbiddenText?: string[];
  invariants?: LiveInvariant[];
  maxDurationMs?: number;
}

export interface LiveToolStep {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  assertions?: LiveOutputAssertions;
}

export interface ContractCase {
  version: number;
  id: string;
  title: string;
  status: LiveCaseStatus;
  risk: ScenarioRisk;
  target: 'staging';
  safety: LiveSafetyLevel;
  tags: string[];
  requiredEnv?: string[];
  steps: LiveToolStep[];
  execution: {
    timeoutMs: number;
  };
  review?: LiveReview;
}

export interface CanaryCase {
  version: number;
  id: string;
  title: string;
  status: LiveCaseStatus;
  risk: ScenarioRisk;
  target: 'production';
  safety: LiveSafetyLevel;
  tags: string[];
  requiredEnv?: string[];
  input: {
    text: string;
  };
  allowedTools: string[];
  assertions: ScenarioAssertions;
  execution: {
    repetitions: number;
    timeoutMs: number;
  };
  review?: LiveReview;
}

export interface LiveToolExecution {
  rawOutput: string;
  parsedOutput: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface ContractStepResult {
  id: string;
  tool: string;
  status: ScenarioRunStatus;
  durationMs: number;
  inputHash: string;
  outputHash: string;
  outputPreview: string;
  assertions: AssertionResult[];
  error?: string;
}

export interface ContractCaseResult {
  caseId: string;
  risk: ScenarioRisk;
  status: ScenarioRunStatus;
  steps: ContractStepResult[];
  durationMs: number;
  error?: string;
}

export interface CanaryExecutionResult {
  answer: string;
  toolCalls: CapturedToolCall[];
  durationMs: number;
  loopRounds: number;
  error?: string;
}

export interface CanaryRepetitionResult {
  repetition: number;
  status: ScenarioRunStatus;
  durationMs: number;
  loopRounds: number;
  toolCalls: number;
  answerHash: string;
  answerPreview: string;
  toolTrace: Array<{
    tool: string;
    success: boolean;
    durationMs?: number;
    inputHash: string;
    outputHash: string;
  }>;
  assertions: AssertionResult[];
  error?: string;
}

export interface CanaryCaseResult {
  caseId: string;
  risk: ScenarioRisk;
  status: ScenarioRunStatus;
  passRate: number;
  repetitions: CanaryRepetitionResult[];
}

export interface LiveRunManifest {
  runId: string;
  kind: 'contract' | 'canary';
  target: LiveTarget;
  dryRun: boolean;
  createdAt: string;
  gitSha: string;
  gitDirty: boolean;
  caseSetHash: string;
  packageVersion: string;
  missingEnv: string[];
  cases: ContractCaseResult[] | CanaryCaseResult[];
}

export interface LiveDryRunCase {
  id: string;
  status: LiveCaseStatus;
  risk: ScenarioRisk;
  safety: LiveSafetyLevel;
  tools: string[];
  missingEnv: string[];
}
