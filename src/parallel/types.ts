import type { AgentResult } from '../agents/base.js';

// --- Parallel config (parsed from spec YAML) ---

export interface ParallelConfig {
  enabled: boolean;
  agent?: string;
  agent_model?: string;
  max_concurrency: number;
  decomposition_hint?: string;
  symlink_directories: string[];
  language?: string;  // explicit language override (e.g. 'python', 'rust', 'go'). Auto-detected if omitted.

  // Feature flags
  test_first?: boolean;              // AgentCoder test-first pattern (default: false)
  repo_map?: boolean;                // AST repo map for coordinator context (default: false)
  dynamic_routing?: boolean;         // Route simple tasks to Sonnet (default: false)
  speculative_architect?: boolean;   // Speculatively run architect in parallel (default: false)
  best_of_n?: number;                // Run N workers for complex tasks (0 = disabled, default: 0)
  merge_tree?: boolean;              // Binary merge tree instead of sequential (default: false)
  entity_ownership?: boolean;        // Entity-level ownership instead of file-level (default: false)
  max_test_iterations?: number;      // Max test-fail-retry loops per worker (default: 3)
}

// --- Coordinator output ---

export interface EntityClaim {
  file: string;
  entity_name: string;
  entity_type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'constant';
}

export interface SubTask {
  id: string;
  name: string;
  prompt: string;
  files: string[];
  reads: string[];
  depends_on: string[];
  entities?: EntityClaim[];  // entity-level ownership for shared large files
}

export interface TaskDecomposition {
  original_prompt: string;
  sub_tasks: SubTask[];
  shared_files: string[];
  execution_order: string[][];
}

// --- Architect output ---

export interface SharedContracts {
  contracts_content: string;
  style_guide: string;
  glue_points: GluePoint[];
  language: string;           // the language contracts are written in
  contracts_file_extension: string;  // '.py', '.ts', '.rs', etc.
}

export interface GluePoint {
  description: string;
  source_task: string;
  target_task: string;
  connection_type: 'import' | 'export' | 'config' | 'type';
}

// --- Worker result ---

export interface WorkerSummary {
  task_id: string;
  files_created: string[];
  files_modified: string[];
  exports_added: string[];
  imports_added: string[];
  contracts_implemented: string[];
  deviations: string[];
}

export interface WorkerResult {
  sub_task_id: string;
  worktree_path: string;
  branch_name: string;
  agent_result: AgentResult;
  files_modified: string[];
  summary?: WorkerSummary;
  ownership_violations?: string[];
  test_iterations?: WorkerTestIteration[];
  complexity?: ComplexityAssessment;
  best_of_n_rank?: number;
}

// --- Test-First Worker types ---

export interface TestSuite {
  test_code: string;
  test_file_path: string;
  framework: string;
  language: string;
}

export interface WorkerTestIteration {
  iteration: number;
  tests_passed: boolean;
  test_output: string;
}

// --- Dynamic model routing ---

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';

export interface ComplexityAssessment {
  complexity: TaskComplexity;
  score: number;   // 0-1
  model: string;
  reasons: string[];
}

// --- Repo map ---

export interface RepoDeclaration {
  name: string;
  kind: string;
  signature: string;
  line: number;
}

export interface RepoMapEntry {
  file: string;
  declarations: RepoDeclaration[];
  exports: string[];
  imports: string[];
}

export interface RepoMap {
  entries: RepoMapEntry[];
  total_files: number;
  total_declarations: number;
  token_estimate: number;
}

// --- Weave merge types ---

export interface WeaveConfig {
  available: boolean;
  binary_path: string;
  supported_extensions: string[];
}

export interface MergeResult {
  success: boolean;
  merged_branch: string;
  conflicts: MergeConflict[];
  merged_files: string[];
  weave_used: boolean;
  weave_resolved: number;
  git_fallback: boolean;
  merge_strategy?: 'octopus' | 'sequential' | 'tree';
}

export interface MergeConflict {
  file: string;
  worktree_a: string;
  worktree_b: string;
  conflict_markers: string;
  is_semantic: boolean;
}

// --- Decomposition scoring ---

export interface DecompositionScore {
  parallelism: number;   // 0-1: width of DAG relative to total tasks
  isolation: number;     // 0-1: inverse of shared_files ratio
  granularity: number;   // 0-1: penalizes over/under-decomposition
  overall: number;       // weighted average
}

// --- QA validation ---

export interface QAValidationResult {
  passed: boolean;
  checks: QACheck[];
}

export interface QACheck {
  name: string;
  passed: boolean;
  details?: string;
}

// --- Failure attribution ---

export interface FailureAttribution {
  worker_id: string;
  confidence: number;   // 0-1
  reason: string;
  files: string[];
}

// --- Retry escalation ---

export type RetryLevel = 'targeted' | 'redecompose' | 'sequential';

export interface RetryContext {
  level: RetryLevel;
  attempt: number;
  failed_workers?: string[];
  failure_feedback?: string;
  previous_decomposition?: TaskDecomposition;
}

// --- Phase results ---

export interface CoordinatorResult {
  decomposition: TaskDecomposition;
  raw_output: string;
  duration: number;
  score?: DecompositionScore;
}

export interface ArchitectResult {
  contracts: SharedContracts;
  raw_output: string;
  duration: number;
}

export interface ParallelStepResult {
  coordinator: CoordinatorResult;
  architect: ArchitectResult | null;
  workers: WorkerResult[];
  merge: MergeResult | null;
  integrator_output: string;
  qa?: QAValidationResult;
  total_duration: number;
  total_processes: number;
  checkpoint_hash: string;
  graceful_degradation?: boolean;
  retry_context?: RetryContext;
}

// --- Retry cache (reuse coordinator/architect across retries) ---

export interface ParallelPhaseCache {
  coordinator?: CoordinatorResult;
  architect?: ArchitectResult;
  successful_workers?: WorkerResult[];
}

// --- Model assignments (centralized) ---

export const PARALLEL_MODELS = {
  coordinator: 'gpt-5.4-mini',
  architect: 'gpt-5.4-mini',
  worker: 'gpt-5.4',
  integrator: 'gpt-5.4-mini',
} as const;

// --- Cost estimation ---

export interface ParallelPlan {
  coordinatorModel: string;
  architectModel: string;
  workerModel: string;
  integratorModel: string;
  workerCount: number;
  totalProcesses: number;
  cachedPhases: string[];
}
