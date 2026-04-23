import chalk from 'chalk';

import type { ExecutorReporter, RunHeaderContext } from '../core/executor.js';
import type { LockstepReceipt } from '../core/hasher.js';
import type { LockstepSpec } from '../core/parser.js';
import type { ValidationResult } from '../validators/base.js';
import type { AgentResult } from '../agents/base.js';
import type { ParallelExecutorReporter } from '../parallel/parallel-executor.js';
import type { CoordinatorResult, ArchitectResult, WorkerResult, MergeResult, ParallelStepResult, ParallelPlan } from '../parallel/types.js';
import { getLockstepVersion } from '../utils/version.js';
import { generateReceiptFiles } from '../core/receipt.js';
import { getPublicSignalName } from '../core/public-surface.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOX_TOP    = chalk.gray('\u256D\u2500');
const BOX_MID    = chalk.gray('\u2502  ');
const BOX_BOT    = chalk.gray('\u2570\u2500');
const SEPARATOR  = chalk.gray('\u2501'.repeat(50));
const PHASE_ARROW = chalk.gray('\u25B8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
}

function getLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function tailLines(text: string, maxLines: number): string[] {
  const lines = getLines(text).filter((line) => line.length > 0);
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}

function excerptLines(text: string, maxLines: number, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const truncated = trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars).trimEnd()}\n... [reporter truncated]`
    : trimmed;

  const lines = getLines(truncated);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), '... [reporter truncated]'];
}

function formatAiJudgeDetails(details?: string): string | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'median_score' in parsed &&
      'all_scores' in parsed &&
      'threshold' in parsed
    ) {
      const median = Number(parsed.median_score).toFixed(1);
      const scores = Array.isArray(parsed.all_scores)
        ? `[${parsed.all_scores.map((s: number) => Number(s).toFixed(1)).join(', ')}]`
        : String(parsed.all_scores);
      const threshold = Number(parsed.threshold).toFixed(1);

      let variancePart = '';
      if (parsed.variance !== undefined && parsed.max_variance !== undefined && parsed.max_variance !== null) {
        const withinBounds = parsed.variance <= parsed.max_variance;
        variancePart = withinBounds
          ? chalk.green(` | var: ${Number(parsed.variance).toFixed(1)} \u2264 ${Number(parsed.max_variance).toFixed(1)}`)
          : chalk.red(` | var: ${Number(parsed.variance).toFixed(1)} > ${Number(parsed.max_variance).toFixed(1)}`);
      }

      return `${median}/10 ${scores} (threshold: ${threshold})${variancePart}`;
    }
  } catch {
    // Not JSON or not the expected shape
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step timeline entry (for final summary)
// ---------------------------------------------------------------------------

interface TimelineEntry {
  stepNum: number;
  name: string;
  passed: boolean;
  durationMs: number;
  retries: number;
}

// ---------------------------------------------------------------------------
// TerminalReporter — Structured phase-based output
// ---------------------------------------------------------------------------

export class TerminalReporter implements ExecutorReporter {
  private agentStartTime = 0;
  private runStartTime = 0;
  private specPath = '';
  private agentLabel = 'Agent';
  private agentLineCount = 0;
  private pendingAgentStderr = '';
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private currentStepRetries = 0;
  private totalRetries = 0;
  private outputDir?: string;
  private verbose: boolean;
  private timeline: TimelineEntry[] = [];
  private currentStepNum = 0;
  constructor(outputDir?: string, verbose?: boolean) {
    this.outputDir = outputDir;
    this.verbose = verbose ?? false;
  }

  // -------------------------------------------------------------------------
  // header
  // -------------------------------------------------------------------------

  header(spec: LockstepSpec, specPath: string, context: RunHeaderContext): void {
    this.runStartTime = Date.now();
    this.specPath = specPath;
    this.agentLabel = spec.config.agent;

    const version = getLockstepVersion();
    const judgeModel = spec.config.judge_model ?? 'provider-default';
    const policyMode = context.policyMode ?? 'built-in';
    const policySummary = context.policyMode
      ? context.policyReviewProvider && context.policyMode !== 'strict'
        ? `${policyMode} (${context.policyReviewProvider})`
        : policyMode
      : 'built-in only';

    console.log('');
    console.log(SEPARATOR);
    console.log(chalk.bold(`  LOCKSTEP v${version}`));
    console.log(SEPARATOR);
    console.log(`  Spec      ${chalk.cyan(specPath)}`);
    console.log(`  Phases    ${chalk.cyan(String(spec.steps.length))}`);
    console.log(`  Runner    ${chalk.cyan(spec.config.agent)}`);
    console.log(`  Review    ${chalk.cyan(judgeModel)} ${chalk.gray(`(${context.judgeMode})`)}`);
    console.log(`  Workflow  ${chalk.cyan(context.workflowPreset ?? 'guarded')}`);
    console.log(`  Autonomy  ${chalk.cyan(spec.config.execution_mode ?? 'standard')}`);
    console.log(`  Policy    ${chalk.cyan(policySummary)}`);
    console.log(`  Effort    ${chalk.cyan(String(spec.config.max_retries))} max passes per phase`);
    console.log(SEPARATOR);
  }

  // -------------------------------------------------------------------------
  // stepStart
  // -------------------------------------------------------------------------

  stepStart(stepNum: number, totalSteps: number, stepName: string): void {
    this.currentStepRetries = 0;
    this.currentStepNum = stepNum;
    console.log('');
    console.log(`${BOX_TOP} ${chalk.bold(`Phase ${stepNum}/${totalSteps}:`)} ${chalk.bold.white(stepName)}`);
  }

  // -------------------------------------------------------------------------
  // retryStart
  // -------------------------------------------------------------------------

  retryStart(_stepName: string, attempt: number, maxAttempts: number, failures: ValidationResult[]): void {
    this.currentStepRetries++;
    this.totalRetries++;

    // Show what failed compactly
    const failSummary = failures
      .map((f) => getPublicSignalName(f.type))
      .reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const failStr = Object.entries(failSummary)
      .map(([type, count]) => `${type}${count > 1 ? ` (${count})` : ''}`)
      .join(', ');

    console.log(`${BOX_MID}${chalk.red('\u2718')} Pass ${attempt - 1} failed: ${chalk.red(failStr)}`);
    console.log(`${BOX_MID}${chalk.yellow('\u21BB')} ${chalk.yellow(`Escalating effort ${attempt}/${maxAttempts}...`)}`);
  }

  // -------------------------------------------------------------------------
  // preCommand
  // -------------------------------------------------------------------------

  preCommandStart(): void {
    process.stdout.write(`${BOX_MID}${PHASE_ARROW} ${chalk.magenta('PRE')}    Running pre-commands...`);
  }

  preCommandComplete(durationMs: number): void {
    process.stdout.write(` ${chalk.green('\u2713')} ${chalk.gray(formatDuration(durationMs))}\n`);
  }

  preCommandFailed(error: string): void {
    process.stdout.write(` ${chalk.red('\u2718')}\n`);
    console.log(`${BOX_MID}         ${chalk.red(error)}`);
  }

  // -------------------------------------------------------------------------
  // agent
  // -------------------------------------------------------------------------

  agentStart(): void {
    this.agentStartTime = Date.now();
    this.agentLineCount = 0;
    this.pendingAgentStderr = '';

    // Start a live timer that updates in-place
    this.renderAgentStatus();
    this.liveTimer = setInterval(() => {
      this.renderAgentStatus();
    }, 1_000);
  }

  agentOutput(text: string): void {
    // Count newlines to track lines received
    const newlines = text.split('\n').length - 1;
    this.agentLineCount += Math.max(newlines, 1);

    if (this.verbose) {
      // In verbose mode, clear the status line, print output, then re-render status
      process.stdout.write('\r\x1b[K');
      process.stdout.write(chalk.gray(text));
      this.renderAgentStatus();
    }
  }

  agentStderr(text: string): void {
    process.stdout.write('\r\x1b[K');

    this.pendingAgentStderr += text;
    const lines = getLines(this.pendingAgentStderr);
    this.pendingAgentStderr = lines.pop() ?? '';

    for (const line of lines) {
      console.log(`${BOX_MID}         ${chalk.red.dim(line)}`);
    }

    if (this.liveTimer) {
      this.renderAgentStatus();
    }
  }

  agentComplete(result: AgentResult): void {
    // Stop the live timer
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }

    const elapsed = formatDuration(result.duration);

    // Clear the live status line and print final
    process.stdout.write('\r\x1b[K');
    const icon = result.success ? chalk.green('\u2713') : chalk.red('\u2718');
    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.blue('AGENT')}  ${this.agentLabel} ` +
      `${chalk.gray(`[${this.agentLineCount} lines]`)} ` +
      `${icon} ${chalk.gray(elapsed)}`,
    );

    if (!result.success) {
      const stderrTail = tailLines(result.stderr, 10);
      if (stderrTail.length > 0) {
        console.log(`${BOX_MID}         ${chalk.red('stderr (last 10 lines):')}`);
        for (const line of stderrTail) {
          console.log(`${BOX_MID}         ${chalk.red.dim(line)}`);
        }
      } else {
        console.log(`${BOX_MID}         ${chalk.red('No stderr output captured.')}`);
      }
    }

    this.pendingAgentStderr = '';
  }

  // -------------------------------------------------------------------------
  // validation
  // -------------------------------------------------------------------------

  validationStart(count: number): void {
    const label = count === 1 ? 'signal' : 'signals';
    console.log(`${BOX_MID}${PHASE_ARROW} ${chalk.blue('VALID')}  Checking ${count} ${label}...`);
  }

  validationResult(result: ValidationResult): void {
    const isAiJudge = result.type === 'ai_judge';
    const signalName = getPublicSignalName(result.type);
    const typeLabel = isAiJudge
      ? chalk.cyan(signalName.toUpperCase())
      : chalk.gray(signalName);
    const duration = result.duration_ms !== undefined
      ? ` ${chalk.gray(formatDuration(result.duration_ms))}`
      : '';

    if (result.passed) {
      if (isAiJudge) {
        const judgeInfo = formatAiJudgeDetails(result.details);
        const display = judgeInfo ?? (result.details || result.target);
        console.log(`${BOX_MID}${PHASE_ARROW} ${typeLabel}  ${chalk.green(display)} ${chalk.green('\u2713')}${duration}`);
      } else {
        const label = result.details || result.target;
        console.log(`${BOX_MID}${PHASE_ARROW} ${typeLabel}  ${label} ${chalk.green('\u2713')}${duration}`);
      }
    } else if (result.optional) {
      console.log(
        `${BOX_MID}${PHASE_ARROW} ${typeLabel}  ${result.target} ` +
        `${chalk.yellow('\u25CB')}${duration} ${chalk.gray('optional')}`,
      );
      this.printValidationFailureDetails(result, false);
    } else {
      if (isAiJudge) {
        const judgeInfo = formatAiJudgeDetails(result.details);
        const display = judgeInfo ?? result.target;
        console.log(`${BOX_MID}${PHASE_ARROW} ${typeLabel}  ${chalk.red(display)} ${chalk.red('\u2718')}${duration}`);
        this.printValidationFailureDetails(result, judgeInfo !== null);
      } else {
        console.log(`${BOX_MID}${PHASE_ARROW} ${typeLabel}  ${chalk.red(result.target)} ${chalk.red('\u2718')}${duration}`);
        this.printValidationFailureDetails(result, false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // step result
  // -------------------------------------------------------------------------

  stepComplete(stepName: string, stepHash: string, durationMs: number): void {
    console.log(`${BOX_MID}${PHASE_ARROW} ${chalk.gray('HASH')}   ${chalk.gray(shortHash(stepHash))}`);

    const retriesNote = this.currentStepRetries > 0
      ? chalk.yellow(` (${this.currentStepRetries} ${this.currentStepRetries === 1 ? 'extra pass' : 'extra passes'})`)
      : '';

    console.log(
      `${BOX_BOT} ${chalk.green('\u2713')} ${chalk.green.bold('Verified')} ` +
      `in ${chalk.white(formatDuration(durationMs))}${retriesNote}`,
    );

    this.timeline.push({
      stepNum: this.currentStepNum,
      name: stepName,
      passed: true,
      durationMs,
      retries: this.currentStepRetries,
    });
  }

  stepFailed(stepName: string, failures: ValidationResult[]): void {
    console.log(`${BOX_BOT} ${chalk.red('\u2718')} ${chalk.red.bold('FAILED')}`);

    if (failures.length > 0) {
      for (const f of failures) {
        console.log(`    ${chalk.red('\u2022')} ${chalk.gray(`[${getPublicSignalName(f.type)}]`)} ${f.target}: ${f.details ?? 'no details'}`);
      }
    }

    this.timeline.push({
      stepNum: this.currentStepNum,
      name: stepName,
      passed: false,
      durationMs: Date.now() - this.runStartTime,
      retries: this.currentStepRetries,
    });
  }

  // -------------------------------------------------------------------------
  // complete — final summary with timeline
  // -------------------------------------------------------------------------

  complete(receipt: LockstepReceipt): void {
    const totalTime = Date.now() - this.runStartTime;

    // Generate receipt files
    let jsonPath = '';
    let markdownPath = '';
    let receiptWriteError: string | null = null;
    try {
      const files = generateReceiptFiles(receipt, this.outputDir);
      jsonPath = files.jsonPath;
      markdownPath = files.markdownPath;
    } catch (error) {
      receiptWriteError = error instanceof Error ? error.message : String(error);
    }

    // Timeline
    console.log('');
    console.log(SEPARATOR);
    console.log(chalk.bold('  Timeline'));
    console.log(SEPARATOR);

    const maxNameLen = Math.max(...this.timeline.map((e) => e.name.length), 10);

    for (const entry of this.timeline) {
      const icon = entry.passed ? chalk.green('\u2713') : chalk.red('\u2718');
      const name = entry.name.padEnd(maxNameLen);
      const dots = chalk.gray('\u00B7'.repeat(Math.max(2, 40 - maxNameLen)));
      const duration = chalk.gray(formatDuration(entry.durationMs));
      const retryNote = entry.retries > 0
        ? chalk.yellow(` (${entry.retries} ${entry.retries === 1 ? 'extra pass' : 'extra passes'})`)
        : '';

      console.log(`  Phase ${entry.stepNum}  ${name} ${dots} ${icon}  ${duration}${retryNote}`);
    }

    console.log(SEPARATOR);

    // Status banner
    if (receipt.status === 'completed') {
      console.log(chalk.bold.green('  ALL PHASES VERIFIED'));
    } else if (receipt.status === 'partial') {
      console.log(chalk.bold.yellow('  PARTIAL RUN (subset of phases)'));
    } else {
      console.log(chalk.bold.red('  FAILED'));

      // Show resume command
      const failedStep = receipt.step_proofs.findIndex(p => !p.all_passed) + 1;
      if (failedStep > 0) {
        console.log('');
        console.log(chalk.yellow('  To resume from the failed phase:'));
        console.log(chalk.white(`  lockstep run ${this.specPath} --from-phase ${failedStep}`));
      }
    }

    // Stats
    const stepsTotal = receipt.steps_passed + receipt.steps_failed;
    const retriesDisplay = this.totalRetries > 0
      ? ` | ${this.totalRetries} ${this.totalRetries === 1 ? 'extra pass' : 'extra passes'}`
      : '';

    console.log(
      `  ${chalk.white(formatDuration(totalTime))} total | ` +
      `${receipt.steps_passed}/${stepsTotal} passed` +
      `${retriesDisplay}`,
    );

    // Chain hash
    console.log(`  Chain: ${chalk.cyan(shortHash(receipt.chain_hash))}`);

    // File paths
    if (jsonPath) {
      console.log(`  Receipt: ${chalk.gray(jsonPath)}`);
    }
    if (markdownPath) {
      console.log(`  Report:  ${chalk.gray(markdownPath)}`);
    }
    if (receiptWriteError) {
      console.log(`  ${chalk.red.bold('Receipt write failed:')} ${chalk.red(receiptWriteError)}`);
    }

    console.log(SEPARATOR);
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Private: live status rendering
  // -------------------------------------------------------------------------

  private renderAgentStatus(): void {
    const elapsed = formatDuration(Date.now() - this.agentStartTime);
    const lines = this.agentLineCount;
    const status = `${BOX_MID}${PHASE_ARROW} ${chalk.blue('AGENT')}  ${this.agentLabel} working... ` +
      `${chalk.gray(`[${lines} lines]`)} ` +
      `${chalk.gray(elapsed)}`;

    process.stdout.write(`\r\x1b[K${status}`);
  }

  private printValidationFailureDetails(result: ValidationResult, skipDetails: boolean): void {
    if (!skipDetails && result.details) {
      console.log(`${BOX_MID}         ${chalk.red(result.details)}`);
    }

    const excerpt = result.stderr_truncated || result.stdout_truncated;
    if (!excerpt) {
      return;
    }

    const excerptLabel = result.stderr_truncated ? 'stderr' : 'stdout';
    const lines = excerptLines(excerpt, 10, 1_500);
    if (lines.length === 0) {
      return;
    }

    console.log(`${BOX_MID}         ${chalk.red(`${excerptLabel}:`)}`);
    for (const line of lines) {
      console.log(`${BOX_MID}         ${chalk.red.dim(line)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ParallelTerminalReporter — Rich output for parallel execution phases
// ---------------------------------------------------------------------------

export class ParallelTerminalReporter implements ParallelExecutorReporter {
  private verbose: boolean;
  private phaseStartTime = 0;
  private liveTimer: ReturnType<typeof setInterval> | null = null;

  // Worker tracking
  private totalTasks = 0;
  private completedWorkers = 0;
  private successfulWorkers = 0;
  private activeWorkerIds = new Set<string>();
  private workerPhaseStartTime = 0;
  private workerNames = new Map<string, string>();

  // Phase durations for summary
  private mergeDuration = 0;
  private integratorDuration = 0;

  constructor(verbose?: boolean) {
    this.verbose = verbose ?? false;
  }

  // -------------------------------------------------------------------------
  // Plan / cost estimation
  // -------------------------------------------------------------------------

  parallelPlan(plan: ParallelPlan): void {
    const cached = plan.cachedPhases.length > 0
      ? ` (${plan.cachedPhases.join(', ')} cached)`
      : '';

    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.white('PLAN')}   ${plan.totalProcesses} processes: ` +
      `${plan.workerCount} workers (${plan.workerModel}) + ` +
      `coord/arch/integ (${plan.coordinatorModel})${cached}`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase warnings
  // -------------------------------------------------------------------------

  phaseWarnings(phase: string, warnings: string[]): void {
    for (const w of warnings) {
      console.log(`${BOX_MID}  ${chalk.yellow('\u26A0')} ${chalk.gray(`[${phase}]`)} ${chalk.yellow(w)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Cached phase reports
  // -------------------------------------------------------------------------

  coordinatorCached(result: CoordinatorResult): void {
    this.totalTasks = result.decomposition.sub_tasks.length;
    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.yellow('COORD')}  ${this.totalTasks} sub-tasks ${chalk.cyan('(cached)')}`,
    );
  }

  architectCached(_result: ArchitectResult): void {
    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.magenta('ARCH')}   Contracts ${chalk.cyan('(cached)')}`,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private startPhaseTimer(label: string, color: (s: string) => string, message: string): void {
    this.phaseStartTime = Date.now();
    this.renderPhaseTimer(label, color, message);
    this.liveTimer = setInterval(() => {
      this.renderPhaseTimer(label, color, message);
    }, 1_000);
  }

  private renderPhaseTimer(label: string, color: (s: string) => string, message: string): void {
    const elapsed = formatDuration(Date.now() - this.phaseStartTime);
    const pad = ' '.repeat(7 - label.length);
    const status = `${BOX_MID}${PHASE_ARROW} ${color(label)}${pad}${message}  ${chalk.gray(elapsed)}`;
    process.stdout.write(`\r\x1b[K${status}`);
  }

  private stopPhaseTimer(): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    process.stdout.write('\r\x1b[K');
  }

  // -------------------------------------------------------------------------
  // Coordinator
  // -------------------------------------------------------------------------

  coordinatorStart(): void {
    this.startPhaseTimer('COORD', chalk.yellow, 'Decomposing task...');
  }

  coordinatorComplete(result: CoordinatorResult): void {
    this.stopPhaseTimer();
    this.totalTasks = result.decomposition.sub_tasks.length;

    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.yellow('COORD')}  Decomposed into ${this.totalTasks} sub-tasks ` +
      `${chalk.green('\u2713')}  ${chalk.gray(formatDuration(result.duration))}`,
    );

    for (const task of result.decomposition.sub_tasks) {
      console.log(
        `${BOX_MID}         ${chalk.gray(task.id)}: ${task.name} (${task.files.length} files)`,
      );
    }

    if (result.decomposition.shared_files.length > 0) {
      console.log(
        `${BOX_MID}         Shared files: ${result.decomposition.shared_files.join(', ')}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Architect
  // -------------------------------------------------------------------------

  architectStart(): void {
    this.startPhaseTimer('ARCH', chalk.magenta, 'Generating contracts...');
  }

  architectComplete(result: ArchitectResult): void {
    this.stopPhaseTimer();

    const glueCount = result.contracts.glue_points.length;
    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.magenta('ARCH')}   Contracts ready (${glueCount} glue points) ` +
      `${chalk.green('\u2713')}  ${chalk.gray(formatDuration(result.duration))}`,
    );
  }

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  workerStart(taskId: string, taskName: string, _worktreePath: string): void {
    // Stop the live worker-output timer if it was running
    if (this.activeWorkerIds.size > 0 && this.liveTimer) {
      this.stopPhaseTimer();
      this.activeWorkerIds.clear();
    }

    this.workerNames.set(taskId, taskName);
  }

  workerOutput(taskId: string, text: string): void {
    const wasEmpty = this.activeWorkerIds.size === 0;
    this.activeWorkerIds.add(taskId);

    if (wasEmpty) {
      this.workerPhaseStartTime = Date.now();
      this.phaseStartTime = this.workerPhaseStartTime;
      this.renderWorkerLiveStatus();
      this.liveTimer = setInterval(() => {
        this.renderWorkerLiveStatus();
      }, 1_000);
    }

    if (this.verbose) {
      process.stdout.write('\r\x1b[K');
      process.stdout.write(`${BOX_MID}         ${chalk.gray(`[${taskId}]`)} ${chalk.gray(text)}`);
      this.renderWorkerLiveStatus();
    }
  }

  private renderWorkerLiveStatus(): void {
    const active = this.activeWorkerIds.size;
    const total = this.totalTasks || '?';
    const elapsed = formatDuration(Date.now() - this.workerPhaseStartTime);
    const status = `${BOX_MID}${PHASE_ARROW} ${chalk.blue('WORK')}   Workers: ${active}/${total} active  ${chalk.gray(elapsed)}`;
    process.stdout.write(`\r\x1b[K${status}`);
  }

  workerComplete(taskId: string, result: WorkerResult): void {
    this.completedWorkers++;
    if (result.agent_result.success) this.successfulWorkers++;

    const name = this.workerNames.get(taskId) ?? taskId;
    const icon = result.agent_result.success ? chalk.green('\u2713') : chalk.red('\u2718');
    const fileCount = result.files_modified.length;
    const filesStr = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.blue('WORK')}   [${taskId}] ${name} ${icon}  ${filesStr}  ${chalk.gray(formatDuration(result.agent_result.duration))}`,
    );
  }

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  mergeStart(weaveAvailable: boolean): void {
    const weaveStr = weaveAvailable ? 'Weave: active' : 'Weave: not found, using git';
    this.startPhaseTimer(
      'MERGE',
      chalk.cyan,
      `Merging ${this.successfulWorkers} branches (${weaveStr})...`,
    );
  }

  mergeComplete(result: MergeResult): void {
    this.mergeDuration = Date.now() - this.phaseStartTime;
    this.stopPhaseTimer();

    const icon = result.success ? chalk.green('\u2713') : chalk.red('\u2718');
    const duration = formatDuration(this.mergeDuration);

    if (result.git_fallback) {
      console.log(
        `${BOX_MID}${PHASE_ARROW} ${chalk.cyan('MERGE')}  Merged ${this.successfulWorkers} branches (git fallback) ${icon}  ${chalk.gray(duration)}`,
      );
      if (result.conflicts.length > 0) {
        console.log(`${BOX_MID}         Conflicts: ${result.conflicts.length}`);
      }
    } else {
      console.log(
        `${BOX_MID}${PHASE_ARROW} ${chalk.cyan('MERGE')}  Merged ${this.successfulWorkers} branches ${icon}  ${chalk.gray(duration)}`,
      );
      if (result.weave_resolved > 0) {
        console.log(`${BOX_MID}         Weave resolved: ${result.weave_resolved} conflicts`);
      }
      const semanticConflicts = result.conflicts.filter((c) => c.is_semantic).length;
      if (semanticConflicts > 0) {
        console.log(`${BOX_MID}         Remaining semantic conflicts: ${semanticConflicts}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Integrator
  // -------------------------------------------------------------------------

  integratorStart(): void {
    this.startPhaseTimer('INTEG', chalk.green, 'Wiring up shared files...');
  }

  integratorComplete(_output: string, duration: number): void {
    this.stopPhaseTimer();
    this.integratorDuration = duration;

    console.log(
      `${BOX_MID}${PHASE_ARROW} ${chalk.green('INTEG')}  Integration complete ${chalk.green('\u2713')}  ${chalk.gray(formatDuration(duration))}`,
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  parallelStepSummary(result: ParallelStepResult): void {
    const workerCount = result.workers.length;
    const maxWorkerDuration = Math.max(...result.workers.map((w) => w.agent_result.duration), 0);

    console.log(`${BOX_MID}`);
    console.log(`${BOX_MID}  ${chalk.gray('\u2500\u2500\u2500')} ${chalk.bold('Parallel Summary')} ${chalk.gray('\u2500\u2500\u2500')}`);
    if (result.graceful_degradation) {
      console.log(
        `${BOX_MID}  Phases: Coordinator(${formatDuration(result.coordinator.duration)}) \u2192 ` +
        `Worker(${formatDuration(maxWorkerDuration)}) [single-task bypass]`,
      );
    } else {
      console.log(
        `${BOX_MID}  Phases: Coordinator(${formatDuration(result.coordinator.duration)}) \u2192 ` +
        `Architect(${formatDuration(result.architect?.duration ?? 0)}) \u2192 ` +
        `Workers\u00D7${workerCount}(${formatDuration(maxWorkerDuration)}) \u2192 ` +
        `Merge(${formatDuration(this.mergeDuration)}) \u2192 ` +
        `Integrator(${formatDuration(this.integratorDuration)})`,
      );
    }
    console.log(
      `${BOX_MID}  Total processes: ${result.total_processes} | Total time: ${formatDuration(result.total_duration)}`,
    );

    if (result.merge?.weave_used) {
      const totalConflicts = result.merge.weave_resolved + result.merge.conflicts.length;
      console.log(
        `${BOX_MID}  Weave: resolved ${result.merge.weave_resolved}/${totalConflicts} conflicts`,
      );
    }

    if (result.qa && !result.qa.passed) {
      const failedChecks = result.qa.checks.filter((c) => !c.passed);
      console.log(`${BOX_MID}  ${chalk.yellow('QA issues:')}`);
      for (const check of failedChecks) {
        console.log(`${BOX_MID}    - ${check.name}: ${check.details ?? 'failed'}`);
      }
    }
  }
}
