import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgent } from '../agents/factory.js';
import { createWorktree } from './worktree-manager.js';
import { writeContractsFile } from './architect.js';
import { enforceFileOwnership } from './ownership-enforcer.js';
import { enforceEntityOwnership } from './entity-ownership.js';
import { assessComplexity } from './complexity-router.js';
import { generateTestSuite, runTestFirstLoop } from './test-designer.js';
import { getProductionRules } from './production-rules.js';
import { resolveParallelRoleModel } from './model-selection.js';
import {
  PARALLEL_MODELS,
  type SubTask,
  type TaskDecomposition,
  type SharedContracts,
  type ParallelConfig,
  type WorkerResult,
  type WorkerSummary,
  type ComplexityAssessment,
  type TestSuite,
} from './types.js';
import type { LanguageInfo } from './language-detect.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the full prompt for an individual worker process.
 * Includes the sub-task prompt, shared contracts, style guide,
 * file ownership boundaries, and context about adjacent tasks.
 */
export function buildWorkerPrompt(
  subTask: SubTask,
  contracts: SharedContracts,
  adjacentTasks: SubTask[],
  language: LanguageInfo,
): string {
  const parts: string[] = [];

  parts.push(
    'You are a parallel worker in a multi-agent execution pipeline.',
    'You are responsible for implementing ONE specific sub-task.',
    'Other workers are handling other parts of the same overall task in parallel.',
    '',
    `This project is written in ${language.name}.`,
    `The shared contracts are written in ${language.name} and use ${language.type_system}.`,
    '',
  );

  // File ownership boundaries
  parts.push(
    '## File Ownership (STRICT)',
    '',
    `You MUST only create/modify these files: ${subTask.files.join(', ') || '(none)'}`,
    'Do NOT touch any other files. Other workers own their files exclusively.',
    '',
  );

  if (subTask.reads.length > 0) {
    parts.push(
      `You may READ (but not modify) these files for reference: ${subTask.reads.join(', ')}`,
      '',
    );
  }

  // Shared contracts
  parts.push(
    '## Shared Contracts',
    '',
    `The following shared ${language.type_system} have been defined by the Architect.`,
    'Import from these contracts as needed. Do NOT modify the contracts file.',
    '',
    `\`\`\`${language.id}`,
    contracts.contracts_content,
    '```',
    '',
  );

  // Style guide
  parts.push(
    '## Style Guide',
    '',
    contracts.style_guide,
    '',
  );

  // Adjacent tasks context
  if (adjacentTasks.length > 0) {
    parts.push(
      '## What Other Workers Are Doing',
      '',
      'For context only — do NOT implement these. Other workers handle them:',
      '',
    );

    for (const adj of adjacentTasks) {
      parts.push(
        `- **${adj.id} (${adj.name}):** ${adj.prompt.slice(0, 200)}${adj.prompt.length > 200 ? '...' : ''}`,
        `  Files: ${adj.files.join(', ') || '(none)'}`,
      );
    }

    parts.push('');
  }

  // Dependency management
  parts.push(
    '## Dependency Management',
    '',
    'If your code imports any external package (e.g. `uuid`, `zod`, `lodash`),',
    'you MUST install it: `npm install <package>` (and `npm install -D @types/<package>` if needed).',
    'If you use Node.js built-in modules with `node:` prefix (e.g. `node:crypto`, `node:fs`),',
    'ensure `@types/node` is installed as a dev dependency.',
    'Do NOT assume dependencies are already installed — always verify.',
    '',
  );

  // Production quality rules
  parts.push(getProductionRules(), '');

  // The actual task
  parts.push(
    '## Your Task',
    '',
    `**${subTask.id}: ${subTask.name}**`,
    '',
    subTask.prompt,
    '',
    '## Final Step: Worker Summary',
    '',
    'After completing your implementation, create a file at `.lockstep/worker-summary.json`',
    'with the following JSON structure (no markdown fences, just raw JSON):',
    '',
    '{',
    `  "task_id": "${subTask.id}",`,
    '  "files_created": ["list of new files you created"],',
    '  "files_modified": ["list of existing files you changed"],',
    '  "exports_added": ["list of exported functions/classes/types you added"],',
    '  "imports_added": ["list of imports you added from other modules"],',
    '  "contracts_implemented": ["list of contract interfaces/types you implemented"],',
    '  "deviations": ["list any deviations from the contracts or style guide, or empty array"]',
    '}',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Execution order resolver
// ---------------------------------------------------------------------------

/**
 * Takes the execution_order from the decomposition (arrays of task IDs)
 * and resolves them to arrays of SubTask objects.
 * Each group can run in parallel; groups execute sequentially.
 */
export function resolveExecutionOrder(
  decomposition: TaskDecomposition,
): SubTask[][] {
  const taskMap = new Map<string, SubTask>();
  for (const task of decomposition.sub_tasks) {
    taskMap.set(task.id, task);
  }

  return decomposition.execution_order.map((group) => {
    const resolved: SubTask[] = [];
    for (const id of group) {
      const task = taskMap.get(id);
      if (task) {
        resolved.push(task);
      }
    }
    return resolved;
  }).filter((group) => group.length > 0);
}

// ---------------------------------------------------------------------------
// Worker group dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a single group of workers in parallel.
 * Each worker gets its own git worktree, a copy of the shared contracts,
 * and runs the configured agent with its specific prompt.
 *
 * Respects max_concurrency by batching tasks within the group.
 * Uses Promise.allSettled for resilience — a single worker failure
 * does not cancel the rest.
 */
export async function dispatchWorkerGroup(
  tasks: SubTask[],
  contracts: SharedContracts,
  allTasks: SubTask[],
  repoPath: string,
  config: ParallelConfig,
  timeout: number,
  language: LanguageInfo,
  onOutput?: (taskId: string, text: string) => void,
  onComplete?: (taskId: string, result: WorkerResult) => void,
  sharedFiles?: string[],
): Promise<WorkerResult[]> {
  const results: WorkerResult[] = [];

  // Batch tasks according to max_concurrency
  const batches: SubTask[][] = [];
  for (let i = 0; i < tasks.length; i += config.max_concurrency) {
    batches.push(tasks.slice(i, i + config.max_concurrency));
  }

  for (const batch of batches) {
    const settled = await Promise.allSettled(
      batch.map((task) => {
        // Best-of-N: run N workers for complex tasks, pick the best
        if (config.best_of_n && config.best_of_n > 1) {
          return dispatchBestOfN(
            task, contracts, allTasks, repoPath, config, timeout, language,
            config.best_of_n, onOutput, sharedFiles,
          );
        }
        return dispatchSingleWorker(
          task, contracts, allTasks, repoPath, config, timeout, language, onOutput, sharedFiles,
        );
      }),
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      let result: WorkerResult;
      if (outcome.status === 'fulfilled') {
        result = outcome.value;
      } else {
        // Worker failed — produce a failed WorkerResult so callers can inspect
        result = {
          sub_task_id: batch[i].id,
          worktree_path: '',
          branch_name: '',
          agent_result: {
            success: false,
            stdout: '',
            stderr: `Worker dispatch failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            combinedOutput: '',
            exitCode: 1,
            duration: 0,
          },
          files_modified: [],
        };
      }
      results.push(result);
      onComplete?.(result.sub_task_id, result);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Single worker dispatcher (internal)
// ---------------------------------------------------------------------------

async function dispatchSingleWorker(
  task: SubTask,
  contracts: SharedContracts,
  allTasks: SubTask[],
  repoPath: string,
  config: ParallelConfig,
  timeout: number,
  language: LanguageInfo,
  onOutput?: (taskId: string, text: string) => void,
  sharedFiles?: string[],
): Promise<WorkerResult> {
  // 1. Dynamic model routing — assess complexity and pick model
  let complexity: ComplexityAssessment | undefined;
  let workerModel = resolveParallelRoleModel(
    config.agent,
    PARALLEL_MODELS.worker,
    config.agent_model,
  );
  if (config.dynamic_routing) {
    complexity = assessComplexity(task);
    workerModel = resolveParallelRoleModel(
      config.agent,
      complexity.model,
      config.agent_model,
    );
  }

  // 2. Create a git worktree for this worker (with symlinks for heavy dirs)
  const symlinkDirs = config.symlink_directories ?? ['node_modules'];
  const worktree = await createWorktree(repoPath, task.id, symlinkDirs);

  // 3. Write the shared contracts file into the worktree
  await writeContractsFile(contracts, worktree.path);

  // 4. Build the worker prompt with adjacent task context
  const adjacentTasks = allTasks.filter((t) => t.id !== task.id);
  const prompt = buildWorkerPrompt(task, contracts, adjacentTasks, language);

  // 5. Generate test suite if test-first is enabled
  let testSuite: TestSuite | null = null;
  if (config.test_first) {
    testSuite = await generateTestSuite(
      task,
      contracts,
      language,
      worktree.path,
      timeout,
      config.agent,
      config.agent_model,
    );
  }

  // 6. Execute the agent in the worktree
  const agent = createAgent(config.agent);
  const agentResult = await agent.execute(prompt, {
    workingDirectory: worktree.path,
    timeout,
    model: workerModel,
    onOutput: onOutput ? (text) => onOutput(task.id, text) : undefined,
  });

  // 7. Detect actually modified files (not just declared ones)
  let filesModified: string[];
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], { cwd: worktree.path });
    const unstaged = stdout.split('\n').map((f) => f.trim()).filter((f) => f.length > 0);
    const { stdout: untrackedOut } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: worktree.path });
    const untracked = untrackedOut.split('\n').map((f) => f.trim()).filter((f) => f.length > 0);
    filesModified = [...new Set([...unstaged, ...untracked])];
  } catch {
    // Fallback to declared files if git detection fails
    filesModified = task.files;
  }

  const result: WorkerResult = {
    sub_task_id: task.id,
    worktree_path: worktree.path,
    branch_name: worktree.branch,
    agent_result: agentResult,
    files_modified: filesModified,
    complexity,
  };

  // 8. Read worker summary if present
  result.summary = await readWorkerSummary(worktree.path);

  // 9. Enforce file ownership — revert unauthorized changes
  if (agentResult.success) {
    await enforceFileOwnership(result, task);

    // 9b. Enforce entity-level ownership for shared files
    if (config.entity_ownership && task.entities && task.entities.length > 0 && sharedFiles) {
      const entityViolations = await enforceEntityOwnership(result, task, sharedFiles);
      if (entityViolations.length > 0) {
        const violationMsgs = entityViolations.map((v) => v.description);
        result.ownership_violations = [
          ...(result.ownership_violations ?? []),
          ...violationMsgs,
        ];
      }
    }
  }

  // 10. Test-first iteration loop (if tests were generated and worker succeeded)
  if (testSuite && agentResult.success) {
    const maxIter = config.max_test_iterations ?? 3;
    const iterations = await runTestFirstLoop(
      testSuite,
      prompt,
      worktree.path,
      timeout,
      maxIter,
      onOutput ? (text) => onOutput(task.id, text) : undefined,
      config.agent,
      config.agent_model,
    );
    result.test_iterations = iterations;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Worker summary reader
// ---------------------------------------------------------------------------

async function readWorkerSummary(
  worktreePath: string,
): Promise<WorkerSummary | undefined> {
  try {
    const summaryPath = path.join(worktreePath, '.lockstep', 'worker-summary.json');
    const content = await readFile(summaryPath, 'utf-8');

    // Strip markdown fences if the model wrapped it
    let jsonStr = content.trim();
    const fencedMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fencedMatch) {
      jsonStr = fencedMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as WorkerSummary;

    // Basic validation
    if (typeof parsed.task_id !== 'string') return undefined;
    if (!Array.isArray(parsed.files_created)) parsed.files_created = [];
    if (!Array.isArray(parsed.files_modified)) parsed.files_modified = [];
    if (!Array.isArray(parsed.exports_added)) parsed.exports_added = [];
    if (!Array.isArray(parsed.imports_added)) parsed.imports_added = [];
    if (!Array.isArray(parsed.contracts_implemented)) parsed.contracts_implemented = [];
    if (!Array.isArray(parsed.deviations)) parsed.deviations = [];

    return parsed;
  } catch {
    // Summary not created or invalid — not fatal
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Best-of-N worker dispatch
// ---------------------------------------------------------------------------

/**
 * Runs N copies of the same worker task with different worktree IDs,
 * then selects the best result based on test pass rate and output quality.
 * The non-selected worktrees are discarded.
 */
async function dispatchBestOfN(
  task: SubTask,
  contracts: SharedContracts,
  allTasks: SubTask[],
  repoPath: string,
  config: ParallelConfig,
  timeout: number,
  language: LanguageInfo,
  n: number,
  onOutput?: (taskId: string, text: string) => void,
  sharedFiles?: string[],
): Promise<WorkerResult> {
  // Create N variants of the task with different IDs for separate worktrees
  const variants: SubTask[] = [];
  for (let i = 0; i < n; i++) {
    variants.push({
      ...task,
      id: `${task.id}-v${i}`,
    });
  }

  // Dispatch all N variants in parallel
  const settled = await Promise.allSettled(
    variants.map((variant) =>
      dispatchSingleWorker(
        variant, contracts, allTasks, repoPath, config, timeout, language,
        onOutput, sharedFiles,
      ),
    ),
  );

  // Collect successful results
  const candidates: WorkerResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      const result = (settled[i] as PromiseFulfilledResult<WorkerResult>).value;
      result.sub_task_id = task.id; // Normalize back to original ID
      result.best_of_n_rank = i;
      candidates.push(result);
    }
  }

  if (candidates.length === 0) {
    // All variants failed — return a failed result
    return {
      sub_task_id: task.id,
      worktree_path: '',
      branch_name: '',
      agent_result: {
        success: false,
        stdout: '',
        stderr: `All ${n} best-of-N variants failed`,
        combinedOutput: '',
        exitCode: 1,
        duration: 0,
      },
      files_modified: [],
    };
  }

  // Select the best candidate
  const best = selectBestCandidate(candidates);
  return best;
}

/**
 * Selects the best worker result from N candidates.
 * Priority: tests all pass > most tests pass > agent success > most files modified
 */
function selectBestCandidate(candidates: WorkerResult[]): WorkerResult {
  // Score each candidate
  const scored = candidates.map((c) => {
    let score = 0;

    // Agent success is the baseline
    if (c.agent_result.success) score += 100;

    // Test iterations: bonus for passing tests
    if (c.test_iterations && c.test_iterations.length > 0) {
      const lastIteration = c.test_iterations[c.test_iterations.length - 1];
      if (lastIteration.tests_passed) {
        score += 200; // Tests pass = highest priority
      }
      // Fewer iterations needed = better implementation
      score += (10 - c.test_iterations.length);
    }

    // Fewer ownership violations = better
    const violations = c.ownership_violations?.length ?? 0;
    score -= violations * 20;

    // More files modified (that were expected) = more complete
    score += c.files_modified.length;

    // Summary present = worker followed instructions
    if (c.summary) score += 10;

    return { candidate: c, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].candidate;
  best.best_of_n_rank = 0; // Mark as the selected winner

  return best;
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches all workers across all execution groups.
 * Groups execute sequentially; tasks within each group run in parallel.
 * Returns a flat array of all WorkerResults.
 */
export async function dispatchAllWorkers(
  decomposition: TaskDecomposition,
  contracts: SharedContracts,
  repoPath: string,
  config: ParallelConfig,
  timeout: number,
  language: LanguageInfo,
  onOutput?: (taskId: string, text: string) => void,
  onComplete?: (taskId: string, result: WorkerResult) => void,
): Promise<WorkerResult[]> {
  const groups = resolveExecutionOrder(decomposition);
  const allResults: WorkerResult[] = [];

  for (const group of groups) {
    const groupResults = await dispatchWorkerGroup(
      group,
      contracts,
      decomposition.sub_tasks,
      repoPath,
      config,
      timeout,
      language,
      onOutput,
      onComplete,
      decomposition.shared_files,
    );
    allResults.push(...groupResults);
  }

  return allResults;
}
