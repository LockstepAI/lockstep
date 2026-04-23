import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { parseSpec } from '../core/parser.js';
import {
  computeCriteriaHash,
  computeStepHash,
} from '../core/hasher.js';
import type {
  AttemptRecord,
  StepProof,
  LockstepReceipt,
} from '../core/hasher.js';
import type { LockstepSpec, LockstepStep } from '../core/parser.js';
import type { ValidationResult } from '../validators/base.js';
import type { JudgeConfig } from '../validators/ai-judge.js';
import { runValidation } from '../validators/registry.js';
import type { AgentResult } from '../agents/base.js';
import { createAgent } from '../agents/factory.js';
import { sha256, hashFileBytes } from '../utils/crypto.js';
import { createWorkspaceCheckpoint } from '../utils/workspace-checkpoint.js';
import { getLockstepVersion } from '../utils/version.js';
import { executeParallelStep } from '../parallel/parallel-executor.js';
import type { ParallelConfig, ParallelPhaseCache } from '../parallel/types.js';
import { ParallelTerminalReporter } from '../reporters/terminal.js';
import { loadPolicy } from '../policy/index.js';
import { canonicalizeValidatorType, getPublicSignalName } from './public-surface.js';
import { loadRC } from '../utils/config.js';
import { applyClaudeAuthModeToProcess } from '../utils/providers.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CLIOptions {
  dryRun?: boolean;
  step?: number;       // run only this step (1-indexed)
  from?: number;       // start from this step (1-indexed)
  verbose?: boolean;
  output?: string;     // custom receipt output directory
}

export interface RunHeaderContext {
  judgeMode: JudgeConfig['mode'];
  workflowPreset?: string;
  policyMode?: string;
  policyReviewProvider?: string;
}

export interface ExecutorReporter {
  header(spec: LockstepSpec, specPath: string, context: RunHeaderContext): void;
  stepStart(stepNum: number, totalSteps: number, stepName: string): void;
  retryStart(stepName: string, attempt: number, maxAttempts: number, failures: ValidationResult[]): void;
  agentStart(): void;
  agentOutput(text: string): void;
  agentStderr(text: string): void;
  agentComplete(result: AgentResult): void;
  preCommandStart(): void;
  preCommandComplete(durationMs: number): void;
  preCommandFailed(error: string): void;
  validationStart(count: number): void;
  validationResult(result: ValidationResult): void;
  stepComplete(stepName: string, stepHash: string, durationMs: number): void;
  stepFailed(stepName: string, failures: ValidationResult[]): void;
  complete(receipt: LockstepReceipt): void;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Constructs the full prompt string sent to the agent for a given step.
 *
 * The prompt includes:
 * 1. Global context (if any) from the spec
 * 2. The step-specific prompt
 * 3. Prior validation failures (on retry attempts) so the agent can
 *    understand what went wrong and correct course
 */
export function buildAgentPrompt(
  step: LockstepStep,
  context: string,
  retryInfo?: { failures: ValidationResult[]; successes?: ValidationResult[] },
): string {
  const parts: string[] = [];

  if (context) {
    parts.push(
      '## Project Context',
      '',
      context,
      '',
    );
  }

  parts.push(
    '## Task',
    '',
    step.prompt,
  );

  if (retryInfo && retryInfo.failures.length > 0) {
    parts.push(
      '',
      '## Previous Attempt Failed',
      '',
      'The previous attempt did not pass all required signals.',
      'Do not regress signals that already passed on the prior attempt.',
      'Please review the failures below and correct the issues:',
      '',
    );

    for (const failure of retryInfo.failures) {
      const signalName = getPublicSignalName(failure.type);
      const label = failure.optional ? `[OPTIONAL] ${signalName}` : signalName;

      // For ai_judge failures, extract the specific violations list
      if (failure.type === 'ai_judge' && failure.details) {
        try {
          const judgeData = JSON.parse(failure.details);
          if (Array.isArray(judgeData.violations) && judgeData.violations.length > 0) {
            parts.push(`- **${label}** scored ${judgeData.median_score}/${judgeData.threshold} — the following issues MUST be fixed:`);
            for (const violation of judgeData.violations) {
              parts.push(`  - ${violation}`);
            }
          } else {
            parts.push(`- **${label}** (target: ${failure.target}): scored ${judgeData.median_score ?? '?'}/${judgeData.threshold ?? '?'}`);
          }
        } catch {
          parts.push(`- **${label}** (target: ${failure.target}): ${failure.details.slice(0, 500)}`);
        }
      } else {
        parts.push(`- **${label}** (target: ${failure.target}): ${failure.details ?? 'no details'}`);
      }
    }

    parts.push(
      '',
      '## Keep These Signals Passing',
      '',
    );

    for (const success of retryInfo.successes ?? []) {
      const signalName = getPublicSignalName(success.type);
      const label = success.optional ? `[OPTIONAL] ${signalName}` : signalName;
      parts.push(`- **${label}** (target: ${success.target})`);
    }

    parts.push(
      '',
      'Fix ALL the issues listed above without breaking the signals that already passed. The review signal will re-evaluate your code.',
    );
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Shell command runner
// ---------------------------------------------------------------------------

async function runShellCommands(
  commands: string[],
  workingDirectory: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  for (const cmd of commands) {
    await execAsync(cmd, { cwd: workingDirectory, timeout: timeoutMs });
  }
}

function formatAgentFailureDetails(result: AgentResult): string {
  const stderrExcerpt = result.stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
  const stdoutExcerpt = result.stdout.trim().replace(/\s+/g, ' ').slice(0, 500);
  const exitCode = Number.isFinite(result.exitCode) ? result.exitCode : 'unknown';

  if (stderrExcerpt) {
    return `Agent execution failed (exit code ${exitCode}). stderr excerpt: ${stderrExcerpt}`;
  }

  if (stdoutExcerpt) {
    return `Agent execution failed (exit code ${exitCode}). stdout excerpt: ${stdoutExcerpt}`;
  }

  return `Agent execution failed (exit code ${exitCode}). No stdout or stderr output captured.`;
}

function getValidationTarget(validatorConfig: Record<string, unknown>): string {
  if (typeof validatorConfig.artifact === 'string') {
    return validatorConfig.artifact;
  }

  if (typeof validatorConfig.target === 'string') {
    return validatorConfig.target;
  }

  if (typeof validatorConfig.command === 'string') {
    return validatorConfig.command;
  }

  if (typeof validatorConfig.probe === 'string') {
    return validatorConfig.probe;
  }

  if (typeof validatorConfig.path === 'string') {
    return validatorConfig.path;
  }

  if (typeof validatorConfig.endpoint === 'string') {
    return validatorConfig.endpoint;
  }

  if (typeof validatorConfig.url === 'string') {
    return validatorConfig.url;
  }

  return 'unknown';
}

function buildValidationErrorResult(
  validatorConfig: Record<string, unknown>,
  reason: unknown,
): ValidationResult {
  const message = reason instanceof Error ? reason.message : String(reason);

  return {
    type: canonicalizeValidatorType(
      typeof validatorConfig.type === 'string'
        ? validatorConfig.type
        : typeof validatorConfig.signal === 'string'
          ? validatorConfig.signal
          : undefined,
    ) ?? 'unknown',
    target: getValidationTarget(validatorConfig),
    passed: false,
    details: `Signal error: ${message}`,
    optional: validatorConfig.optional as boolean | undefined,
  };
}

// ---------------------------------------------------------------------------
// Judge config detection
// ---------------------------------------------------------------------------

function detectJudgeConfig(spec: LockstepSpec): JudgeConfig {
  return {
    mode: spec.config.judge_mode ?? 'codex',
    model: spec.config.judge_model,
    effortLevel: spec.config.effort_level,
  };
}

// ---------------------------------------------------------------------------
// Step filtering helpers
// ---------------------------------------------------------------------------

function resolveStepRange(
  totalSteps: number,
  options: CLIOptions,
): { startIndex: number; endIndex: number } {
  // --step takes precedence: run exactly one step
  if (options.step !== undefined) {
    const idx = options.step - 1;
    if (idx < 0 || idx >= totalSteps) {
      throw new Error(
        `--phase ${options.step} is out of range (plan has ${totalSteps} phase${totalSteps === 1 ? '' : 's'})`,
      );
    }
    return { startIndex: idx, endIndex: idx };
  }

  // --from: run from this step onward
  if (options.from !== undefined) {
    const idx = options.from - 1;
    if (idx < 0 || idx >= totalSteps) {
      throw new Error(
        `--from-phase ${options.from} is out of range (plan has ${totalSteps} phase${totalSteps === 1 ? '' : 's'})`,
      );
    }
    return { startIndex: idx, endIndex: totalSteps - 1 };
  }

  // Default: all steps
  return { startIndex: 0, endIndex: totalSteps - 1 };
}

// ---------------------------------------------------------------------------
// Empty receipt for dry-run mode
// ---------------------------------------------------------------------------

function buildEmptyReceipt(
  spec: LockstepSpec,
  specPath: string,
  specHash: string,
): LockstepReceipt {
  const now = new Date().toISOString();
  return {
    version: '1',
    hash_algorithm: 'sha256',
    canonicalization: 'json-stable-stringify',
    lockstep_version: getLockstepVersion(),
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    runner_cli_version: 'dry-run',
    spec_file: specPath,
    spec_hash: specHash,
    agent: spec.config.agent,
    judge_model: spec.config.judge_model ?? 'provider-default',
    judge_mode: 'dry-run',
    judge_runs: 0,
    started_at: now,
    completed_at: now,
    total_steps: spec.steps.length,
    steps_passed: 0,
    steps_failed: 0,
    step_proofs: [],
    chain_hash: 'genesis',
    status: 'completed',
  };
}

// ---------------------------------------------------------------------------
// Count ai_judge validations across the spec (for receipt metadata)
// ---------------------------------------------------------------------------

function countJudgeRuns(spec: LockstepSpec): number {
  let count = 0;
  for (const step of spec.steps) {
    for (const v of step.validate) {
      if (v.type === 'ai_judge') {
        // Each ai_judge validator runs 3 times (median-of-3)
        count += 3;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full Lockstep execution pipeline:
 *
 * 1. Parses and validates the spec file
 * 2. Iterates over each step (respecting `--step` and `--from` filters)
 * 3. For each step, retries the agent up to `maxRetries` until all required
 *    validations pass
 * 4. Builds a cryptographic proof chain across steps
 * 5. Returns the final receipt (the CLI handler writes it to disk)
 */
export async function executeLockstep(
  specPath: string,
  options: CLIOptions,
  reporter: ExecutorReporter,
): Promise<LockstepReceipt> {
  // -------------------------------------------------------------------------
  // 1. Parse spec and gather metadata
  // -------------------------------------------------------------------------

  const spec = parseSpec(specPath);
  const specHash = hashFileBytes(specPath);
  const judgeConfig = detectJudgeConfig(spec);
  const savedDefaults = loadRC();
  const claudeAuthMode = spec.config.claude_auth_mode ?? savedDefaults.claude_auth_mode;

  if (claudeAuthMode) {
    applyClaudeAuthModeToProcess(claudeAuthMode);
  }

  const specDir = path.dirname(path.resolve(specPath));
  const workingDirectory = path.resolve(specDir, spec.config.working_directory);
  const policy = loadPolicy(workingDirectory);
  reporter.header(spec, specPath, {
    judgeMode: judgeConfig.mode,
    workflowPreset: savedDefaults.workflow_preset,
    policyMode: policy.mode,
    policyReviewProvider: policy.review?.provider,
  });

  // -------------------------------------------------------------------------
  // 2. Dry-run: validate and return early
  // -------------------------------------------------------------------------

  if (options.dryRun) {
    return buildEmptyReceipt(spec, specPath, specHash);
  }

  const runnerVersion = 'not-used';

  // -------------------------------------------------------------------------
  // 5. Resolve working directory and policy
  // -------------------------------------------------------------------------

  const agent = createAgent(spec.config.agent);

  // -------------------------------------------------------------------------
  // 6. Initialize the receipt shell
  // -------------------------------------------------------------------------

  const startedAt = new Date().toISOString();
  const maxRetries = spec.config.max_retries;
  const receipt: LockstepReceipt = {
    version: '1',
    hash_algorithm: 'sha256',
    canonicalization: 'json-stable-stringify',
    lockstep_version: getLockstepVersion(),
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    runner_cli_version: runnerVersion,
    spec_file: path.resolve(specPath),
    spec_hash: specHash,
    agent: spec.config.agent,
    judge_model: judgeConfig.model ?? 'provider-default',
    judge_mode: judgeConfig.mode,
    judge_runs: countJudgeRuns(spec),
    started_at: startedAt,
    completed_at: '',     // filled after execution
    total_steps: spec.steps.length,
    steps_passed: 0,
    steps_failed: 0,
    step_proofs: [],
    chain_hash: 'genesis',
    status: 'completed',  // optimistic — set to "failed" if any step fails
  };

  // -------------------------------------------------------------------------
  // 7. Resolve which steps to run
  // -------------------------------------------------------------------------

  const { startIndex, endIndex } = resolveStepRange(spec.steps.length, options);

  // 8b. Execute steps
  // -------------------------------------------------------------------------

  let previousStepHash = 'genesis';

  try {
  for (let i = startIndex; i <= endIndex; i++) {
    const step = spec.steps[i];
    const stepNum = i + 1; // 1-indexed for display
    const stepTimeoutMs = (step.timeout ?? spec.config.step_timeout) * 1000;
    const stepMaxRetries = step.retries ?? maxRetries;

    const stepStartedMs = Date.now();
    reporter.stepStart(stepNum, spec.steps.length, step.name);

    // -----------------------------------------------------------------------
    // Retry loop
    // -----------------------------------------------------------------------

    const attempts: AttemptRecord[] = [];
    let stepPassed = false;
      let lastFailures: ValidationResult[] = [];
      let lastSuccesses: ValidationResult[] = [];
    let parallelCheckpointHash: string | undefined;
    let parallelCache: ParallelPhaseCache | undefined;
    const workspaceCheckpoint = await createWorkspaceCheckpoint(workingDirectory);

    try {
      for (let attempt = 1; attempt <= stepMaxRetries; attempt++) {
        const attemptStartedAt = new Date().toISOString();

        if (attempt > 1) {
          reporter.retryStart(step.name, attempt, stepMaxRetries, lastFailures);
          await workspaceCheckpoint.restore();
        }

      // -------------------------------------------------------------------
      // Pre-commands (every attempt for deterministic retries)
      // -------------------------------------------------------------------

      if (step.pre_commands && step.pre_commands.length > 0) {
        reporter.preCommandStart();
        const preStart = Date.now();
        try {
          await runShellCommands(step.pre_commands, workingDirectory, stepTimeoutMs);
          reporter.preCommandComplete(Date.now() - preStart);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reporter.preCommandFailed(message);
          // Record a failed attempt due to pre_command failure
          const attemptRecord: AttemptRecord = {
            attempt_number: attempt,
            prompt_hash: '',
            agent_stdout_hash: '',
            agent_stderr_hash: '',
            validations: [{
              type: 'pre_command',
              target: 'pre_commands',
              passed: false,
              details: `Pre-command failed: ${message}`,
            }],
            all_required_passed: false,
            started_at: attemptStartedAt,
            completed_at: new Date().toISOString(),
          };
          attempts.push(attemptRecord);
          lastFailures = attemptRecord.validations;
          continue;
        }
      }

      // -------------------------------------------------------------------
      // Build agent prompt
      // -------------------------------------------------------------------

      const retryInfo = attempt > 1 && lastFailures.length > 0
        ? { failures: lastFailures, successes: lastSuccesses }
        : undefined;

      const prompt = buildAgentPrompt(
        step,
        spec.context ?? '',
        retryInfo,
      );

      const promptHash = sha256(prompt);

      // -------------------------------------------------------------------
      // Execute agent (parallel or sequential)
      // -------------------------------------------------------------------

      let agentStdoutHash: string;
      let agentStderrHash: string;

        const parallelEnabled = spec.config.parallel?.enabled ?? false;

        if (parallelEnabled) {
          if (!parallelCheckpointHash) {
            parallelCheckpointHash = workspaceCheckpoint.id;
          }

          const parallelReporter = new ParallelTerminalReporter(options.verbose);

          const parallelConfig: ParallelConfig = {
            enabled: true,
            agent: spec.config.agent,
            agent_model: step.model ?? spec.config.agent_model,
            max_concurrency: spec.config.parallel.max_concurrency,
            decomposition_hint: spec.config.parallel.decomposition_hint,
            symlink_directories: spec.config.parallel.symlink_directories ?? ['node_modules'],
            language: spec.config.parallel.language,
          };

          const parallelResult = await executeParallelStep(
            prompt,
            spec.context ?? '',
            parallelConfig,
            workingDirectory,
            stepTimeoutMs,
            parallelReporter,
            parallelCache,
          );

        // Cache coordinator/architect for retry optimization
          if (!parallelCache) {
            parallelCache = {
              coordinator: parallelResult.coordinator,
              architect: parallelResult.architect ?? undefined,
            };
          }

        // Concatenate all phase outputs for hashing
          const combinedStdout = [
            parallelResult.coordinator.raw_output,
            parallelResult.architect?.raw_output ?? '',
            ...parallelResult.workers.map((w) => w.agent_result.stdout),
            parallelResult.integrator_output,
          ].join('\n');

          const combinedStderr = parallelResult.workers
            .map((w) => w.agent_result.stderr)
            .filter(Boolean)
            .join('\n');

          agentStdoutHash = sha256(combinedStdout);
          agentStderrHash = sha256(combinedStderr);

        // Check if parallel execution failed (all workers crashed, integrator failed)
          const anyWorkerFailed = parallelResult.workers.some(
            (w) => !w.agent_result.success,
          );
          if (anyWorkerFailed && !parallelResult.integrator_output) {
            const agentFailure: ValidationResult = {
              type: 'agent_execution',
              target: 'parallel',
              passed: false,
              details: 'Parallel agent execution failed: one or more workers did not complete successfully',
            };

            const attemptRecord: AttemptRecord = {
              attempt_number: attempt,
              prompt_hash: promptHash,
              agent_stdout_hash: agentStdoutHash,
              agent_stderr_hash: agentStderrHash,
              validations: [agentFailure],
              all_required_passed: false,
              started_at: attemptStartedAt,
              completed_at: new Date().toISOString(),
            };

            attempts.push(attemptRecord);
            lastFailures = [agentFailure];
            lastSuccesses = [];
            continue;
          }
        } else {
          // Sequential execution (original path)
          reporter.agentStart();

          const agentResult = await agent.execute(prompt, {
            workingDirectory,
            timeout: stepTimeoutMs,
            model: step.model ?? spec.config.agent_model,
            effortLevel: spec.config.effort_level,
            executionMode: spec.config.execution_mode,
            policy,
            onOutput: (text) => reporter.agentOutput(text),
            onStderr: (text) => reporter.agentStderr(text),
          });

          reporter.agentComplete(agentResult);

          agentStdoutHash = sha256(agentResult.stdout);
          agentStderrHash = sha256(agentResult.stderr);

          if (!agentResult.success) {
            const stderrExcerpt = agentResult.stderr.trim().slice(0, 500);
            const agentFailure: ValidationResult = {
              type: 'agent_execution',
              target: agent.name,
              passed: false,
              details: formatAgentFailureDetails(agentResult),
              exit_code: agentResult.exitCode,
              duration_ms: agentResult.duration,
              stderr_truncated: stderrExcerpt || undefined,
            };

            const attemptRecord: AttemptRecord = {
              attempt_number: attempt,
              prompt_hash: promptHash,
              agent_stdout_hash: agentStdoutHash,
              agent_stderr_hash: agentStderrHash,
              validations: [agentFailure],
              all_required_passed: false,
              started_at: attemptStartedAt,
              completed_at: new Date().toISOString(),
            };

            attempts.push(attemptRecord);
            lastFailures = [agentFailure];
            continue;
          }
        }

        // -------------------------------------------------------------------
        // Run validations
        // -------------------------------------------------------------------

        reporter.validationStart(step.validate.length);

      // Run validators in parallel for speed
        const validatorContext = {
          workingDirectory,
          stepTimeout: step.timeout ?? spec.config.step_timeout,
        };

        const settledValidationResults = await Promise.allSettled(
          step.validate.map((validatorConfig) =>
            runValidation(
              validatorConfig as Record<string, unknown>,
              validatorContext,
              validatorConfig.type === 'ai_judge' ? judgeConfig : undefined,
            ),
          ),
        );

        const validationResults = settledValidationResults.map((settledResult, index) => {
          if (settledResult.status === 'fulfilled') {
            return settledResult.value;
          }

          return buildValidationErrorResult(
            step.validate[index] as Record<string, unknown>,
            settledResult.reason,
          );
        });

      // Report results sequentially for clean output
        for (const result of validationResults) {
          reporter.validationResult(result);
        }

      // -------------------------------------------------------------------
      // Determine if all required validations passed
      // -------------------------------------------------------------------

        const allRequiredPassed = validationResults.every(
          (v) => v.passed || v.optional === true,
        );

      // -------------------------------------------------------------------
      // Record the attempt
      // -------------------------------------------------------------------

        const attemptRecord: AttemptRecord = {
          attempt_number: attempt,
          prompt_hash: promptHash,
          agent_stdout_hash: agentStdoutHash,
          agent_stderr_hash: agentStderrHash,
          validations: validationResults,
          all_required_passed: allRequiredPassed,
          started_at: attemptStartedAt,
          completed_at: new Date().toISOString(),
        };

        attempts.push(attemptRecord);

      // -------------------------------------------------------------------
      // Check pass/fail
      // -------------------------------------------------------------------

        if (allRequiredPassed) {
          stepPassed = true;
          break;
        }

        // Collect failures for the next retry prompt
        lastFailures = validationResults.filter(
          (v) => !v.passed && v.optional !== true,
        );
        lastSuccesses = validationResults.filter(
          (v) => v.passed || v.optional === true,
        );
      }
    } finally {
      await workspaceCheckpoint.dispose();
    }

      // -----------------------------------------------------------------------
      // Post-commands (only if step passed)
      // -----------------------------------------------------------------------

      if (stepPassed && step.post_commands && step.post_commands.length > 0) {
        try {
          await runShellCommands(step.post_commands, workingDirectory);
        } catch (err) {
          // Post-command failure does not fail the step, but we log it.
          // The step already passed validation — post_commands are housekeeping.
          const message = err instanceof Error ? err.message : String(err);
          if (options.verbose) {
            process.stderr.write(
              `Warning: post_command failed for step "${step.name}": ${message}\n`,
            );
          }
        }
      }

    // -----------------------------------------------------------------------
    // Build StepProof
    // -----------------------------------------------------------------------

      const criteriaHash = computeCriteriaHash(
        step.validate.map((v) => v as Record<string, unknown>),
      );

      const proof: StepProof = {
        step_index: i,
        step_name: step.name,
        criteria_hash: criteriaHash,
        attempts,
        final_attempt: attempts.length,
        all_passed: stepPassed,
        previous_step_hash: previousStepHash,
        step_hash: '', // computed next
      };

      proof.step_hash = computeStepHash(proof);
      previousStepHash = proof.step_hash;

      receipt.step_proofs.push(proof);

    // -----------------------------------------------------------------------
    // Report and update counters
    // -----------------------------------------------------------------------

      if (stepPassed) {
        receipt.steps_passed++;
        reporter.stepComplete(step.name, proof.step_hash, Date.now() - stepStartedMs);
      } else {
        receipt.steps_failed++;
        reporter.stepFailed(step.name, lastFailures);
        receipt.status = 'failed';
        break; // Stop executing further steps on failure
      }
    }

  // -------------------------------------------------------------------------
  // 10. Finalize receipt
  // -------------------------------------------------------------------------

  receipt.completed_at = new Date().toISOString();
  receipt.chain_hash = previousStepHash;

  // Determine final status
  if (receipt.status !== 'failed') {
    // Check if we ran all steps or just a subset
    const ranAllSteps = startIndex === 0 && endIndex === spec.steps.length - 1;
    receipt.status = ranAllSteps ? 'completed' : 'partial';
  }

  reporter.complete(receipt);

    return receipt;
  } catch (crashError) {
    // Generate partial receipt on crash — never lose proof of completed steps
    receipt.completed_at = new Date().toISOString();
    receipt.chain_hash = previousStepHash;
    receipt.status = 'failed';

    if (receipt.step_proofs.length > 0) {
      try {
        reporter.complete(receipt);
      } catch {
        // Last resort: write receipt directly
        const { generateReceiptFiles } = await import('../core/receipt.js');
        try {
          generateReceiptFiles(receipt, options.output);
          process.stderr.write(`\nPartial receipt saved after crash (${receipt.step_proofs.length}/${receipt.total_steps} steps)\n`);
        } catch {
          process.stderr.write('\nFailed to save partial receipt after crash\n');
        }
      }
    }

    throw crashError;
  }
}
