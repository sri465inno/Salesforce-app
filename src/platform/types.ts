export type TestType = 'smoke' | 'positive' | 'negative' | 'boundary' | 'e2e';
export type Channel = 'ui' | 'api';
export const TEST_TYPES: TestType[] = ['smoke', 'positive', 'negative', 'boundary', 'e2e'];
export const SKILLS = ['playwright-ui', 'graphql-api', 'synthetic-data', 'defect-triage'] as const;
export type Skill = (typeof SKILLS)[number];

export type GateId = 'requirements-baseline' | 'test-design' | 'execution' | 'release';
export type StageId =
  | 'intake'
  | 'requirements'
  | 'review'
  | 'gate-requirements-baseline'
  | 'business-rules'
  | 'test-design'
  | 'gate-test-design'
  | 'test-data'
  | 'automation'
  | 'gate-execution'
  | 'execution'
  | 'defects'
  | 'reporting'
  | 'gate-release';
export type StageStatus = 'pending' | 'running' | 'completed' | 'waiting-approval' | 'rejected' | 'failed' | 'interrupted';

export interface ArtifactRef {
  label: string;
  /** Path relative to AQE_HOME, served at /artifacts/<path>. */
  path: string;
}

export interface StageState {
  id: StageId;
  name: string;
  agent: string | null;
  gate: GateId | null;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  inputs: string[];
  outputs: ArtifactRef[];
  summary: string | null;
  error: string | null;
}

export type Decision = 'approved' | 'rejected';
export type FindingDecisionValue = 'accept' | 'reject' | 'defer';

export interface FindingDecision {
  findingId: string;
  decision: FindingDecisionValue;
  comment: string;
}

export interface Approval {
  id: string;
  gate: GateId;
  approver: string;
  decision: Decision;
  comments: string;
  timestamp: string;
  findingDecisions?: FindingDecision[];
}

export interface CycleConfig {
  mode: 'baseline' | 'incremental';
  testingTypes: TestType[];
  channels: Channel[];
  inputs: string[];
  skills: Skill[];
  requestedBy: string;
  /** Demo-service defects switched off for this cycle (demonstrates a passing re-run). */
  fixedDefects?: string[];
}

export interface Cycle {
  id: string;
  config: CycleConfig;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'waiting-approval' | 'completed' | 'rejected' | 'failed' | 'interrupted';
  stages: StageState[];
  approvals: Approval[];
  baselineId: string | null;
  previousBaselineId: string | null;
  demoServiceBuild: string | null;
}

export interface Provenance {
  source: string;
  path: string;
  sha256: string;
  recordedFrom: string;
}

export interface InputDocument {
  key: string;
  file: string;
  sha256: string;
  recordedFrom: string;
  content: unknown;
}

export interface Requirement {
  id: string;
  kind: 'story' | 'acceptance-criterion' | 'epic-criterion' | 'business-rule-statement' | 'reviewer-added';
  text: string;
  sourceId: string;
  version: number;
  status: 'draft' | 'baselined' | 'merged' | 'excluded';
  mergedInto?: string;
  reviewerNote?: string;
  provenance: Provenance;
  contentHash: string;
}

export interface ReviewFinding {
  id: string;
  type: 'missing' | 'duplicate' | 'conflict' | 'code-only';
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  recommendation: string;
  affected: string[];
  evidence: { source: string; quote: string }[];
  proposedAction:
    | { type: 'merge'; from: string; into: string }
    | { type: 'add-requirement'; text: string; ruleId: string }
    | { type: 'clarify'; requirementId: string; note: string }
    | { type: 'include-code-rule'; ruleId: string; text: string };
}

export type RuleKind = 'validation' | 'constraint' | 'decision' | 'outcome';

export interface RuleCheck {
  /** How the rule is exercised by generated tests. */
  type: 'date-order' | 'min-exclusive' | 'reference' | 'approved-value' | 'generated-output' | 'required-fields' | 'availability' | 'format' | 'authorization';
  fields: string[];
  errorCode: string | null;
  /** e.g. threshold for min-exclusive, approved values for approved-value */
  parameters: Record<string, unknown>;
}

export interface BusinessRule {
  id: string;
  text: string;
  kind: RuleKind;
  entity: string;
  condition: string;
  expectedOutcome: string;
  check: RuleCheck;
  sourceRequirements: string[];
  codeReferences: { file: string; line: number; symbol: string }[];
  origin: 'catalogue' | 'code-only (reviewer accepted)';
  criticality: 'critical' | 'high' | 'medium';
}

export interface TestCase {
  id: string;
  title: string;
  type: TestType;
  channel: Channel;
  ruleIds: string[];
  requirementIds: string[];
  objective: string;
  preconditions: string[];
  steps: string[];
  expected: { success: boolean; errorCode?: string; confirmationPattern?: string; status?: string };
  /** Mutation applied to the valid base dataset. */
  mutation: Record<string, unknown>;
  /** Dataset checks this case must intentionally violate (validated by the Test Data Agent). */
  violates: string[];
  flow?: 'create' | 'create-search-cancel' | 'health';
  priority: 'P1' | 'P2' | 'P3';
}

export interface DatasetCheck {
  field: string;
  rule: string;
  result: 'pass' | 'intentional-violation' | 'fail';
  detail: string;
}

export interface Dataset {
  id: string;
  testCaseId: string;
  classification: 'SYNTHETIC';
  version: number;
  provenance: { generator: string; seed: string; dictionaryVersion: string; dictionarySha256: string; generatedAt: string };
  values: {
    locationId: string | null;
    startDate: string | null;
    endDate: string | null;
    customerCount: number | null;
    resourceType: string | null;
    customer: { firstName: string | null; lastName: string | null; email: string | null };
    payment: { paymentMethod: string | null; paymentToken: string | null };
  };
  intentionalViolations: string[];
  validation: { status: 'valid' | 'invalid'; checks: DatasetCheck[]; privacy: DatasetCheck[] };
}

export interface AutomationScript {
  id: string;
  testCaseId: string;
  datasetId: string;
  ruleIds: string[];
  requirementIds: string[];
  channel: Channel;
  file: string;
  sha256: string;
}

export interface EvidenceItem {
  id: string;
  kind: 'screenshot' | 'trace' | 'request-response' | 'service-log' | 'stdout' | 'error';
  path: string;
  label: string;
}

export interface ExecutionResult {
  id: string;
  testCaseId: string;
  scriptId: string;
  datasetId: string;
  status: 'passed' | 'failed' | 'skipped' | 'not-run';
  durationMs: number;
  startedAt: string | null;
  error: { message: string; expected: string | null; actual: string | null } | null;
  evidence: EvidenceItem[];
}

export interface ExecutionSummary {
  runId: string;
  executed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  demoServiceBuild: string;
  baseURL: string;
  playwrightExitCode: number;
  totals: { total: number; passed: number; failed: number; skipped: number; notRun: number };
  results: ExecutionResult[];
}

export interface Defect {
  id: string;
  title: string;
  status: 'open';
  severity: 'critical' | 'high' | 'medium' | 'low';
  blocksRelease: boolean;
  ruleId: string;
  requirementIds: string[];
  testCaseIds: string[];
  executionIds: string[];
  evidenceIds: string[];
  expected: string;
  actual: string;
  impact: string;
  suspectedCause: string;
  codeReference: { file: string; line: number; symbol: string; excerpt: string[] } | null;
  suggestedRemediation: string;
  createdAt: string;
  createdFrom: 'execution-failure';
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  actorType: 'human' | 'agent' | 'system';
  action: 'approval' | 'execution' | 'access' | 'reset' | 'deletion' | 'cycle' | 'retention' | 'lab';
  target: string;
  details: Record<string, unknown>;
}
