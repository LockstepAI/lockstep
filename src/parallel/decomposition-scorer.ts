import type { TaskDecomposition, DecompositionScore } from './types.js';

// ---------------------------------------------------------------------------
// Decomposition scoring
// ---------------------------------------------------------------------------

// Thresholds for warnings/errors
const MIN_ACCEPTABLE_SCORE = 0.3;
const WARN_SCORE_THRESHOLD = 0.5;
const MAX_FILES_PER_TASK = 10;
const MIN_PROMPT_LENGTH = 50;

/**
 * Scores a task decomposition on three axes:
 * - parallelism: how much work runs concurrently (wider DAG = better)
 * - isolation: fewer shared files = better (less merge risk)
 * - granularity: penalizes over-decomposition and under-decomposition
 *
 * Each score is 0-1. Overall is a weighted average.
 */
export function scoreDecomposition(
  decomposition: TaskDecomposition,
): DecompositionScore {
  const parallelism = scoreParallelism(decomposition);
  const isolation = scoreIsolation(decomposition);
  const granularity = scoreGranularity(decomposition);

  const overall = parallelism * 0.4 + isolation * 0.35 + granularity * 0.25;

  return { parallelism, isolation, granularity, overall };
}

/**
 * Parallelism score: ratio of tasks in the widest execution group
 * to total tasks. Higher = more parallel work.
 *
 * Single-task decomposition = 0 (no parallelism benefit).
 * All tasks in one group = 1.0.
 */
function scoreParallelism(decomposition: TaskDecomposition): number {
  const { sub_tasks, execution_order } = decomposition;

  if (sub_tasks.length <= 1) return 0;
  if (execution_order.length === 0) return 0;

  const maxGroupSize = Math.max(...execution_order.map((g) => g.length));
  return maxGroupSize / sub_tasks.length;
}

/**
 * Isolation score: inverse of shared_files ratio.
 * 0 shared files = 1.0 (perfect isolation).
 * All files shared = 0.0 (no isolation).
 */
function scoreIsolation(decomposition: TaskDecomposition): number {
  const totalOwnedFiles = decomposition.sub_tasks.reduce(
    (sum, t) => sum + t.files.length, 0,
  );
  const totalFiles = totalOwnedFiles + decomposition.shared_files.length;

  if (totalFiles === 0) return 1;

  return totalOwnedFiles / totalFiles;
}

/**
 * Granularity score: penalizes decompositions that are too coarse
 * or too fine-grained.
 *
 * Ideal: 2-6 tasks for a typical step.
 * Over-decomposition (>8 tasks with few files each) = penalty.
 * Under-decomposition (1 task with many files) = penalty.
 */
function scoreGranularity(decomposition: TaskDecomposition): number {
  const n = decomposition.sub_tasks.length;

  if (n === 0) return 0;
  if (n === 1) return 0.3; // Not terrible, just no parallelism benefit

  // Penalize too many tasks
  if (n > 8) {
    return Math.max(0.2, 1 - (n - 8) * 0.1);
  }

  // Check for tasks with too many files (should be split)
  const overloadedTasks = decomposition.sub_tasks.filter(
    (t) => t.files.length > MAX_FILES_PER_TASK,
  );
  if (overloadedTasks.length > 0) {
    return Math.max(0.3, 1 - overloadedTasks.length * 0.15);
  }

  // Check for tasks with very short prompts (likely meaningless)
  const weakPrompts = decomposition.sub_tasks.filter(
    (t) => t.prompt.length < MIN_PROMPT_LENGTH,
  );
  if (weakPrompts.length > 0) {
    return Math.max(0.4, 1 - weakPrompts.length * 0.1);
  }

  // Sweet spot: 2-6 tasks
  if (n >= 2 && n <= 6) return 1.0;

  // 7-8 tasks: slight penalty
  return 0.9;
}

/**
 * Generates warnings based on the decomposition score.
 */
export function getScoreWarnings(score: DecompositionScore): string[] {
  const warnings: string[] = [];

  if (score.overall < MIN_ACCEPTABLE_SCORE) {
    warnings.push(
      `Decomposition score critically low (${score.overall.toFixed(2)}) — consider re-decomposing`,
    );
  } else if (score.overall < WARN_SCORE_THRESHOLD) {
    warnings.push(
      `Decomposition score below threshold (${score.overall.toFixed(2)})`,
    );
  }

  if (score.parallelism === 0) {
    warnings.push('No parallelism benefit — single task or fully sequential');
  } else if (score.parallelism < 0.3) {
    warnings.push(
      `Low parallelism (${score.parallelism.toFixed(2)}) — most tasks are sequential`,
    );
  }

  if (score.isolation < 0.5) {
    warnings.push(
      `Low isolation (${score.isolation.toFixed(2)}) — many shared files increase merge risk`,
    );
  }

  if (score.granularity < 0.4) {
    warnings.push(
      `Poor granularity (${score.granularity.toFixed(2)}) — over/under-decomposed`,
    );
  }

  return warnings;
}
