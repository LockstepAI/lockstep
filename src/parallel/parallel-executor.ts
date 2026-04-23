import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
  PARALLEL_MODELS,
  type ParallelConfig,
  type CoordinatorResult,
  type ArchitectResult,
  type WorkerResult,
  type MergeResult,
  type ParallelStepResult,
  type ParallelPhaseCache,
  type ParallelPlan,
  type QAValidationResult,
  type RetryContext,
  type RepoMap,
} from './types.js';
import { createAgent } from '../agents/factory.js';
import { runCoordinator } from './coordinator.js';
import { runArchitect } from './architect.js';
import type { LanguageInfo } from './language-detect.js';
import { detectProjectLanguage, getLanguageById } from './language-detect.js';
import { dispatchAllWorkers } from './worker-dispatcher.js';
import { mergeAllWorktrees, detectWeave, autoResolveAllConflicts } from './merge-engine.js';
import { runIntegrator } from './integrator.js';
import { cleanupAllWorktrees } from './worktree-manager.js';
import {
  validateCoordinatorQuality,
  validateArchitectQuality,
} from './phase-validator.js';
import { runQAValidation } from './qa-validator.js';
import { attributeFailure, selectWorkersForRetry } from './failure-attribution.js';
import { generateRepoMap } from './repo-map.js';
import { routeTasks } from './complexity-router.js';
import { resolveParallelRoleModel } from './model-selection.js';
import {
  createWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from '../utils/workspace-checkpoint.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Reporter interface
// ---------------------------------------------------------------------------

export interface ParallelExecutorReporter {
  parallelPlan(plan: ParallelPlan): void;
  coordinatorStart(): void;
  coordinatorComplete(result: CoordinatorResult): void;
  coordinatorCached(result: CoordinatorResult): void;
  phaseWarnings(phase: string, warnings: string[]): void;
  architectStart(): void;
  architectComplete(result: ArchitectResult): void;
  architectCached(result: ArchitectResult): void;
  workerStart(taskId: string, taskName: string, worktreePath: string): void;
  workerOutput(taskId: string, text: string): void;
  workerComplete(taskId: string, result: WorkerResult): void;
  mergeStart(weaveAvailable: boolean): void;
  mergeComplete(result: MergeResult): void;
  integratorStart(): void;
  integratorComplete(output: string, duration: number): void;
  qaStart?(): void;
  qaComplete?(result: QAValidationResult): void;
  gracefulDegradation?(reason: string): void;
  ownershipViolations?(taskId: string, violations: string[]): void;
  retryEscalation?(context: RetryContext): void;
  repoMapGenerated?(tokenEstimate: number, fileCount: number): void;
  speculativeArchitectStart?(): void;
  speculativeArchitectResult?(matched: boolean): void;
  dynamicRouting?(assessments: Map<string, import('./types.js').ComplexityAssessment>): void;
  testFirstResults?(taskId: string, iterations: import('./types.js').WorkerTestIteration[]): void;
  bestOfNResult?(taskId: string, candidateCount: number): void;
  mergeStrategy?(strategy: string): void;
  parallelStepSummary(result: ParallelStepResult): void;
}

// ---------------------------------------------------------------------------
// Git checkpoint helpers
// ---------------------------------------------------------------------------

export async function saveCheckpoint(
  workingDirectory: string,
): Promise<WorkspaceCheckpoint> {
  return createWorkspaceCheckpoint(workingDirectory);
}

export async function rollbackToCheckpoint(
  _workingDirectory: string,
  checkpoint: WorkspaceCheckpoint,
): Promise<void> {
  await checkpoint.restore();
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function executeParallelStep(
  stepPrompt: string,
  context: string,
  config: ParallelConfig,
  workingDirectory: string,
  timeout: number,
  reporter: ParallelExecutorReporter,
  cache?: ParallelPhaseCache,
  retryContext?: RetryContext,
): Promise<ParallelStepResult> {
  const totalStart = Date.now();
  let processCount = 0;
  const checkpoint = await saveCheckpoint(workingDirectory);
  const cachedPhases: string[] = [];

  const language: LanguageInfo = config.language
    ? getLanguageById(config.language)
    : await detectProjectLanguage(workingDirectory);

  try {
    // -----------------------------------------------------------------
    // PRE-PHASE — Generate repo map if enabled
    // -----------------------------------------------------------------

    let repoMap: RepoMap | undefined;
    if (config.repo_map) {
      try {
        repoMap = await generateRepoMap(workingDirectory, language);
        reporter.repoMapGenerated?.(repoMap.token_estimate, repoMap.total_files);
      } catch {
        // Repo map generation failed — proceed without it
      }
    }

    // -----------------------------------------------------------------
    // PHASE 1 — COORDINATOR (skip if cached)
    // Optionally run architect speculatively in parallel
    // -----------------------------------------------------------------

    let coordinatorResult: CoordinatorResult;
    let speculativeArchitectResult: ArchitectResult | null = null;

    if (cache?.coordinator) {
      coordinatorResult = cache.coordinator;
      cachedPhases.push('coordinator');
      reporter.coordinatorCached(coordinatorResult);
    } else if (config.speculative_architect && !cache?.architect) {
      // SPECULATIVE ARCHITECT: run coordinator and architect in parallel
      // The architect gets a "guessed" decomposition based on the prompt
      reporter.coordinatorStart();
      reporter.speculativeArchitectStart?.();
      processCount += 2; // coordinator + speculative architect

      const [coordResult, specArchResult] = await Promise.allSettled([
        runCoordinator(stepPrompt, context, config, workingDirectory, timeout, language, repoMap),
        runArchitect(
          // Pass a synthetic decomposition for the speculative architect
          { original_prompt: stepPrompt, sub_tasks: [], shared_files: [], execution_order: [] },
          context,
          workingDirectory,
          timeout,
          language,
          config.agent,
          config.agent_model,
        ),
      ]);

      if (coordResult.status === 'rejected') {
        throw new Error(
          `Coordinator agent failed: ${coordResult.reason instanceof Error ? coordResult.reason.message : String(coordResult.reason)}`,
        );
      }

      coordinatorResult = coordResult.value;
      reporter.coordinatorComplete(coordinatorResult);

      // Speculative architect result — will be validated later
      if (specArchResult.status === 'fulfilled') {
        speculativeArchitectResult = specArchResult.value;
      }
    } else {
      reporter.coordinatorStart();
      processCount++;

      coordinatorResult = await runCoordinator(
        stepPrompt,
        context,
        config,
        workingDirectory,
        timeout,
        language,
        repoMap,
      );

      reporter.coordinatorComplete(coordinatorResult);
    }

    const { decomposition } = coordinatorResult;

    if (decomposition.sub_tasks.length === 0) {
      throw new Error(
        'Coordinator produced an empty decomposition with no sub-tasks',
      );
    }

    // Inter-phase validation: coordinator quality + scoring
    const coordValidation = validateCoordinatorQuality(decomposition);
    if (!coordValidation.valid) {
      throw new Error(
        `Coordinator produced invalid decomposition:\n${coordValidation.errors.map((e) => `  - ${e}`).join('\n')}`,
      );
    }
    if (coordValidation.warnings.length > 0) {
      reporter.phaseWarnings('coordinator', coordValidation.warnings);
    }

    // Attach score to coordinator result
    coordinatorResult.score = coordValidation.score;

    // -----------------------------------------------------------------
    // DYNAMIC ROUTING — assess task complexity
    // -----------------------------------------------------------------

    if (config.dynamic_routing) {
      const assessments = routeTasks(decomposition.sub_tasks, true);
      reporter.dynamicRouting?.(assessments);
    }

    // -----------------------------------------------------------------
    // GRACEFUL DEGRADATION — single task bypass
    // -----------------------------------------------------------------

    if (decomposition.sub_tasks.length === 1) {
      reporter.gracefulDegradation?.('Single sub-task — bypassing architect/merge/integrator');

      return await executeSingleTaskBypass(
        decomposition,
        coordinatorResult,
        config,
        workingDirectory,
        timeout,
        language,
        reporter,
        totalStart,
        processCount,
        checkpoint.id,
      );
    }

    // -----------------------------------------------------------------
    // COST ESTIMATION — now that we know the decomposition
    // -----------------------------------------------------------------

    const workerCount = decomposition.sub_tasks.length;
    const bestOfNMultiplier = config.best_of_n && config.best_of_n > 1 ? config.best_of_n : 1;
    const totalProcesses = (cache?.coordinator ? 0 : 1)
      + (cache?.architect ? 0 : 1)
      + (workerCount * bestOfNMultiplier)
      + 1; // integrator
    const defaultApiModel = process.env.LOCKSTEP_MODEL?.trim() ?? '(provider default)';

    reporter.parallelPlan({
      coordinatorModel: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.coordinator, config.agent_model) ?? defaultApiModel,
      architectModel: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.architect, config.agent_model) ?? defaultApiModel,
      workerModel: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.worker, config.agent_model) ?? defaultApiModel,
      integratorModel: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.integrator, config.agent_model) ?? defaultApiModel,
      workerCount: workerCount * bestOfNMultiplier,
      totalProcesses,
      cachedPhases,
    });

    // -----------------------------------------------------------------
    // PHASE 2 — ARCHITECT (skip if cached or use speculative result)
    // -----------------------------------------------------------------

    let architectResult: ArchitectResult;

    if (cache?.architect) {
      architectResult = cache.architect;
      cachedPhases.push('architect');
      reporter.architectCached(architectResult);
    } else if (speculativeArchitectResult) {
      // Validate speculative architect result against actual decomposition
      const specValidation = await validateArchitectQuality(
        speculativeArchitectResult.contracts,
        decomposition,
        language,
      );

      if (specValidation.valid) {
        architectResult = speculativeArchitectResult;
        reporter.speculativeArchitectResult?.(true);
        reporter.architectComplete(architectResult);
      } else {
        // Speculative result doesn't match — run architect properly
        reporter.speculativeArchitectResult?.(false);
        reporter.architectStart();
        processCount++;

        architectResult = await runArchitect(
          decomposition,
          context,
          workingDirectory,
          timeout,
          language,
          config.agent,
          config.agent_model,
        );

        reporter.architectComplete(architectResult);
      }
    } else {
      reporter.architectStart();
      processCount++;

      architectResult = await runArchitect(
        decomposition,
        context,
        workingDirectory,
        timeout,
        language,
        config.agent,
        config.agent_model,
      );

      reporter.architectComplete(architectResult);
    }

    // Inter-phase validation: architect quality
    const archValidation = await validateArchitectQuality(
      architectResult.contracts,
      decomposition,
      language,
    );
    if (!archValidation.valid) {
      throw new Error(
        `Architect produced invalid contracts:\n${archValidation.errors.map((e) => `  - ${e}`).join('\n')}`,
      );
    }
    if (archValidation.warnings.length > 0) {
      reporter.phaseWarnings('architect', archValidation.warnings);
    }

    // -----------------------------------------------------------------
    // PHASE 3 — WORKERS
    // -----------------------------------------------------------------

    // Report worker starts before dispatch
    for (const task of decomposition.sub_tasks) {
      reporter.workerStart(task.id, task.name, '');
    }

    const workerResults = await dispatchAllWorkers(
      decomposition,
      architectResult.contracts,
      workingDirectory,
      config,
      timeout,
      language,
      (taskId, text) => reporter.workerOutput(taskId, text),
      (taskId, result) => {
        reporter.workerComplete(taskId, result);
        // Report ownership violations
        if (result.ownership_violations && result.ownership_violations.length > 0) {
          reporter.ownershipViolations?.(taskId, result.ownership_violations);
        }
        // Report test-first results
        if (result.test_iterations && result.test_iterations.length > 0) {
          reporter.testFirstResults?.(taskId, result.test_iterations);
        }
        // Report best-of-N selection
        if (result.best_of_n_rank !== undefined) {
          reporter.bestOfNResult?.(taskId, config.best_of_n ?? 1);
        }
      },
    );

    processCount += workerResults.length;

    // Check that at least one worker succeeded
    const successfulWorkers = workerResults.filter((wr) => wr.agent_result.success);
    if (successfulWorkers.length === 0) {
      throw new Error(
        `All ${workerResults.length} workers failed. Errors:\n${workerResults
          .map((wr) => `  - ${wr.sub_task_id}: ${wr.agent_result.stderr.slice(0, 200)}`)
          .join('\n')}`,
      );
    }

    // -----------------------------------------------------------------
    // PHASE 4 — MERGE (Octopus first, then sequential Weave fallback)
    // -----------------------------------------------------------------

    const weaveConfig = await detectWeave();
    reporter.mergeStart(weaveConfig.available);

    const mergeResult = await mergeAllWorktrees(
      successfulWorkers,
      workingDirectory,
      config,
    );

    reporter.mergeComplete(mergeResult);

    if (mergeResult.merge_strategy) {
      reporter.mergeStrategy?.(mergeResult.merge_strategy);
    }

    // -----------------------------------------------------------------
    // PHASE 5 — INTEGRATOR
    // -----------------------------------------------------------------

    reporter.integratorStart();
    processCount++;

    const integratorResult = await runIntegrator(
      decomposition,
      architectResult.contracts,
      mergeResult,
      workerResults,
      workingDirectory,
      timeout,
      config.agent,
      config.agent_model,
    );

    reporter.integratorComplete(integratorResult.output, integratorResult.duration);

    // Post-integrator safety net: resolve any remaining conflict markers
    // that the integrator missed.
    const postIntegratorResolved = await autoResolveAllConflicts(workingDirectory);
    if (postIntegratorResolved > 0) {
      try {
        await execAsync('git add -A && git commit -m "lockstep: auto-resolve remaining conflict markers"', {
          cwd: workingDirectory,
        });
      } catch {
        // Nothing to commit — auto-resolve found markers but they were already clean
      }
    }

    // -----------------------------------------------------------------
    // PHASE 5.5 — QA VALIDATION
    // -----------------------------------------------------------------

    reporter.qaStart?.();

    const qaResult = await runQAValidation(
      workingDirectory,
      architectResult.contracts,
      workerResults,
      language,
    );

    reporter.qaComplete?.(qaResult);

    // -----------------------------------------------------------------
    // Build result
    // -----------------------------------------------------------------

    const result: ParallelStepResult = {
      coordinator: coordinatorResult,
      architect: architectResult,
      workers: workerResults,
      merge: mergeResult,
      integrator_output: integratorResult.output,
      qa: qaResult,
      total_duration: Date.now() - totalStart,
      total_processes: processCount,
      checkpoint_hash: checkpoint.id,
      retry_context: retryContext,
    };

    reporter.parallelStepSummary(result);

    // Ensure all changes are committed so the next step's worktrees branch correctly
    try {
      await execAsync('git add -A && git diff --cached --quiet || git commit -m "lockstep: step complete"', {
        cwd: workingDirectory,
      });
    } catch {
      // Non-fatal
    }

    return result;
  } finally {
    // -----------------------------------------------------------------
    // CLEANUP — always remove worktrees
    // -----------------------------------------------------------------

    try {
      await cleanupAllWorktrees(workingDirectory);
    } catch {
      // Cleanup failure should not mask the original error
    }
    await checkpoint.dispose();
  }
}

// ---------------------------------------------------------------------------
// Single-task bypass (graceful degradation)
// ---------------------------------------------------------------------------

async function executeSingleTaskBypass(
  decomposition: import('./types.js').TaskDecomposition,
  coordinatorResult: CoordinatorResult,
  config: ParallelConfig,
  workingDirectory: string,
  timeout: number,
  _language: LanguageInfo,
  reporter: ParallelExecutorReporter,
  totalStart: number,
  processCount: number,
  checkpointHash: string,
): Promise<ParallelStepResult> {
  const task = decomposition.sub_tasks[0];
  reporter.workerStart(task.id, task.name, workingDirectory);

  // Run the single worker directly in the main repo (no worktree needed)
  const agent = createAgent(config.agent);
  const agentResult = await agent.execute(task.prompt, {
    workingDirectory,
    timeout,
    model: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.worker, config.agent_model),
  });

  processCount++;

  const workerResult: WorkerResult = {
    sub_task_id: task.id,
    worktree_path: workingDirectory,
    branch_name: 'main',
    agent_result: agentResult,
    files_modified: task.files,
  };

  reporter.workerComplete(task.id, workerResult);

  // Commit the single-task result so the next step's worktrees branch from it
  try {
    await execAsync('git add -A && git diff --cached --quiet || git commit -m "lockstep: step complete (single-task)"', {
      cwd: workingDirectory,
    });
  } catch {
    // Non-fatal — files may already be committed by the agent
  }

  return {
    coordinator: coordinatorResult,
    architect: null,
    workers: [workerResult],
    merge: null,
    integrator_output: agentResult.stdout,
    total_duration: Date.now() - totalStart,
    total_processes: processCount,
    checkpoint_hash: checkpointHash,
    graceful_degradation: true,
  };
}

// ---------------------------------------------------------------------------
// Retry escalation (3-level)
// ---------------------------------------------------------------------------

/**
 * Determines the next retry strategy based on failure context.
 *
 * Level 1 (targeted): Retry only failed workers, keep successful branches.
 * Level 2 (redecompose): Invalidate coordinator cache, re-decompose with feedback.
 * Level 3 (sequential): Fall back to single-agent sequential execution.
 */
export function determineRetryLevel(
  currentAttempt: number,
  errorMessage: string,
  decomposition: import('./types.js').TaskDecomposition,
  workerResults: WorkerResult[],
): RetryContext {
  // Level 1: targeted worker retry (first retry attempt)
  if (currentAttempt <= 1) {
    const attributions = attributeFailure(errorMessage, decomposition, workerResults);
    const failedWorkers = selectWorkersForRetry(attributions);

    if (failedWorkers.length > 0 && failedWorkers.length < workerResults.length) {
      return {
        level: 'targeted',
        attempt: currentAttempt,
        failed_workers: failedWorkers,
        failure_feedback: errorMessage.slice(0, 500),
      };
    }
  }

  // Level 2: re-decompose with feedback (second retry attempt)
  if (currentAttempt <= 2) {
    return {
      level: 'redecompose',
      attempt: currentAttempt,
      failure_feedback: errorMessage.slice(0, 500),
      previous_decomposition: decomposition,
    };
  }

  // Level 3: sequential fallback (third+ retry attempt)
  return {
    level: 'sequential',
    attempt: currentAttempt,
    failure_feedback: errorMessage.slice(0, 500),
  };
}

/**
 * Builds the retry cache based on the current retry context.
 * For targeted retries, preserves coordinator/architect and successful workers.
 * For redecompose, clears coordinator cache.
 * For sequential, clears everything.
 */
export function buildRetryCache(
  retryContext: RetryContext,
  previousResult: ParallelStepResult,
): ParallelPhaseCache {
  switch (retryContext.level) {
    case 'targeted':
      return {
        coordinator: previousResult.coordinator,
        architect: previousResult.architect ?? undefined,
        successful_workers: previousResult.workers.filter(
          (wr) =>
            wr.agent_result.success &&
            !retryContext.failed_workers?.includes(wr.sub_task_id),
        ),
      };

    case 'redecompose':
      // Clear coordinator cache to force re-decomposition
      return {
        // No coordinator cache — force fresh decomposition
        // No architect cache — new decomposition needs new contracts
      };

    case 'sequential':
      // Clear everything — sequential fallback
      return {};
  }
}
