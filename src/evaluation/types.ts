export type ScenarioRisk = 'low' | 'medium' | 'high' | 'critical';
export type ScenarioCaseStatus = 'draft' | 'approved' | 'quarantined' | 'deprecated';
export type ScenarioRunMode = 'self-test' | 'frozen' | 'live';
export type ScenarioRunStatus = 'passed' | 'failed' | 'error' | 'inconclusive';

export interface ScenarioTaxonomyEntry {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  toolCategories?: string[];
}

export interface ScenarioTaxonomy {
  version: number;
  scenarios: ScenarioTaxonomyEntry[];
  recommendedTags?: string[];
}

export interface ScenarioSource {
  /** Irreversible hash of the original telemetry turn id. */
  turnHash?: string;
  observedAt?: string;
  telemetryIncomplete?: boolean;
  notes?: string;
}

export interface ScenarioInput {
  text: string;
  agent: string;
  role: string;
  channel: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  fixedTime?: string;
}

export type ToolInputMatchMode = 'any' | 'exact' | 'subset' | 'contains';

export interface ToolInputMatcher {
  mode: ToolInputMatchMode;
  value?: unknown;
}

export interface ToolFixtureResponse {
  input?: ToolInputMatcher;
  output: unknown;
  success?: boolean;
  error?: string;
}

export interface ToolFixture {
  tool: string;
  responses: ToolFixtureResponse[];
}

export interface RequiredToolAssertion {
  tool: string;
  minCalls?: number;
  maxCalls?: number;
}

export interface ToolInputAssertion {
  tool: string;
  call?: number;
  input: ToolInputMatcher;
}

export interface ScenarioAssertions {
  requiredTools?: RequiredToolAssertion[];
  forbiddenTools?: string[];
  allowedTools?: string[];
  toolOrder?: string[];
  toolInputs?: ToolInputAssertion[];
  requiredFacts?: string[];
  forbiddenClaims?: string[];
  answerRegex?: string[];
  maxToolCalls?: number;
  maxLoopRounds?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ScenarioJudgeRubric {
  enabled: boolean;
  minScore?: number;
  criteria?: string[];
  referenceAnswer?: string;
}

export interface ScenarioExecutionPolicy {
  mode: ScenarioRunMode;
  repetitions: number;
  timeoutMs: number;
}

export interface ScenarioReview {
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
}

export interface ScenarioCase {
  version: number;
  id: string;
  title: string;
  scenario: string;
  status: ScenarioCaseStatus;
  risk: ScenarioRisk;
  priority: number;
  tags: string[];
  source?: ScenarioSource;
  input: ScenarioInput;
  fixtures: ToolFixture[];
  assertions: ScenarioAssertions;
  judge: ScenarioJudgeRubric;
  execution: ScenarioExecutionPolicy;
  review?: ScenarioReview;
}

export interface CapturedToolCall {
  tool: string;
  input: unknown;
  output: string;
  success: boolean;
  error?: string;
  round?: number;
  durationMs?: number;
}

export interface ScenarioExecutionResult {
  caseId: string;
  repetition: number;
  answer: string;
  toolCalls: CapturedToolCall[];
  loopRounds: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface JudgeResult {
  status: 'passed' | 'failed' | 'inconclusive';
  score?: number;
  rationale?: string;
  model?: string;
  error?: string;
}

export interface ScenarioRepetitionResult {
  repetition: number;
  status: ScenarioRunStatus;
  assertions: AssertionResult[];
  judge?: JudgeResult;
  metrics: {
    durationMs: number;
    toolCalls: number;
    loopRounds: number;
    inputTokens: number;
    outputTokens: number;
  };
  answer?: string;
  toolTrace?: CapturedToolCall[];
  error?: string;
}

export interface ScenarioCaseRunResult {
  caseId: string;
  scenario: string;
  risk: ScenarioRisk;
  status: ScenarioRunStatus;
  repetitions: ScenarioRepetitionResult[];
  passRate: number;
  medianJudgeScore?: number;
}

export interface ScenarioRunManifest {
  runId: string;
  suite: string;
  createdAt: string;
  gitSha: string;
  gitDirty: boolean;
  caseSetHash: string;
  provider: string;
  model: string;
  judgeProvider?: string;
  judgeModel?: string;
  cases: ScenarioCaseRunResult[];
}

export interface TelemetryCandidateToolCall {
  name: string;
  round: number;
  success: boolean;
  input?: string;
  outputPreview?: string;
  error?: string;
}

export interface TelemetryScenarioCandidate {
  candidateId: string;
  turnHash: string;
  observedAt: string;
  agent: string;
  channel: string;
  question: string;
  answerPreview: string;
  telemetryIncomplete: boolean;
  scenario: string;
  suggestedTags: string[];
  fingerprint: string;
  clusterSize: number;
  priorityScore: number;
  toolCalls: TelemetryCandidateToolCall[];
  metrics: {
    loopRounds: number;
    totalToolCalls: number;
    toolFailures: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    stopReason: string;
  };
}

export interface TelemetryCandidateReport {
  version: number;
  generatedAt: string;
  sourceFiles: string[];
  totalTurns: number;
  eligibleTurns: number;
  malformedLines: number;
  candidates: TelemetryScenarioCandidate[];
  coverage: Array<{
    scenario: string;
    candidates: number;
    turns: number;
  }>;
}
