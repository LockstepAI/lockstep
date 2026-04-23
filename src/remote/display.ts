import chalk from 'chalk';

import type {
  ProcessingResponse as ProcessingState,
  PromptReadyResponse as PromptReadyState,
  TerminalResponse as TerminalState,
  ValidationResult,
} from './api.js';

export interface RunHeader {
  specPath: string;
  apiUrl: string;
  workingDirectory: string;
  totalSteps: number;
  agent: string;
  judgeMode: 'api' | 'subscription';
  judgeModel?: string;
}

export interface AgentExecutionSummary {
  success: boolean;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface ProgressDisplay {
  header(summary: RunHeader): void;
  runCreated(runId: string): void;
  processing(state: ProcessingState): void;
  promptReady(state: PromptReadyState, totalSteps: number): void;
  preCommandsStart(commands: string[]): void;
  preCommandsComplete(durationMs: number): void;
  preCommandsFailed(message: string): void;
  agentStart(timeoutMs: number): void;
  agentStdout(text: string): void;
  agentStderr(text: string): void;
  agentComplete(summary: AgentExecutionSummary): void;
  validationStart(count: number): void;
  validationResult(result: ValidationResult): void;
  postCommandsStart(commands: string[]): void;
  postCommandsComplete(durationMs: number): void;
  postCommandsWarning(message: string): void;
  resultSubmitted(status: string): void;
  warning(message: string): void;
  info(message: string): void;
  complete(state: TerminalState): void;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 12)}...`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class ConsoleDisplay implements ProgressDisplay {
  private readonly verbose: boolean;
  private lastProcessingKey = '';
  private streamedAgentOutput = false;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  header(summary: RunHeader): void {
    console.log('');
    console.log(chalk.bold('LOCKSTEP'));
    console.log(`  Spec:      ${chalk.cyan(summary.specPath)}`);
    console.log(`  API:       ${chalk.cyan(summary.apiUrl)}`);
    console.log(`  Workdir:   ${chalk.cyan(summary.workingDirectory)}`);
    console.log(`  Steps:     ${chalk.cyan(String(summary.totalSteps))}`);
    console.log(`  Agent:     ${chalk.cyan(summary.agent)}`);
    console.log(
      `  Judge:     ${chalk.cyan(summary.judgeModel ?? 'provider-default')} ${chalk.gray(`(${summary.judgeMode})`)}`,
    );
  }

  runCreated(runId: string): void {
    console.log(`  Run ID:    ${chalk.cyan(runId)}`);
  }

  processing(state: ProcessingState): void {
    const current = Number.isFinite(state.currentStep) ? state.currentStep + 1 : 0;
    const key = `${current}:${state.totalSteps}`;

    if (key === this.lastProcessingKey) {
      return;
    }

    this.lastProcessingKey = key;
    console.log('');
    console.log(
      chalk.gray(
        `Waiting for server: step ${Math.max(current, 1)}/${Math.max(state.totalSteps, 1)} is still processing`,
      ),
    );
  }

  promptReady(state: PromptReadyState, totalSteps: number): void {
    this.lastProcessingKey = '';
    console.log('');
    console.log(
      chalk.bold(`Step ${state.stepIndex + 1}/${totalSteps}: ${state.stepName}`) +
        ` ${chalk.gray(`(attempt ${state.attempt}/${state.maxRetries})`)}`,
    );
  }

  preCommandsStart(commands: string[]): void {
    console.log(chalk.magenta(`Pre-commands (${commands.length})`));
  }

  preCommandsComplete(durationMs: number): void {
    console.log(`  ${chalk.green('ok')} ${chalk.gray(formatDuration(durationMs))}`);
  }

  preCommandsFailed(message: string): void {
    console.log(`  ${chalk.red('failed')} ${chalk.red(oneLine(message))}`);
  }

  agentStart(timeoutMs: number): void {
    this.streamedAgentOutput = false;
    console.log(chalk.blue(`Agent running ${chalk.gray(`(timeout ${formatDuration(timeoutMs)})`)}`));
  }

  agentStdout(text: string): void {
    if (!this.verbose) return;
    this.streamedAgentOutput = true;
    process.stdout.write(chalk.gray(text));
  }

  agentStderr(text: string): void {
    if (!this.verbose) return;
    this.streamedAgentOutput = true;
    process.stderr.write(chalk.yellow(text));
  }

  agentComplete(summary: AgentExecutionSummary): void {
    if (this.verbose && this.streamedAgentOutput) {
      process.stdout.write('\n');
    }

    const status = summary.success ? chalk.green('ok') : chalk.yellow('non-zero exit');
    const timeoutNote = summary.timedOut ? ` ${chalk.red('(timed out)')}` : '';
    console.log(
      `${chalk.blue('Agent complete')} ${status} ${chalk.gray(
        `(code ${summary.exitCode}, ${formatDuration(summary.durationMs)})`,
      )}${timeoutNote}`,
    );
  }

  validationStart(count: number): void {
    console.log(chalk.blue(`Validations (${count})`));
  }

  validationResult(result: ValidationResult): void {
    const status = result.passed
      ? chalk.green('PASS')
      : result.optional
        ? chalk.yellow('FAIL optional')
        : chalk.red('FAIL');

    const details = result.details
      ? ` - ${oneLine(result.details)}`
      : result.exit_code !== undefined
        ? ` - exit ${result.exit_code}`
        : '';

    console.log(`  ${status} ${result.type} ${chalk.gray(result.target)}${details}`);
  }

  postCommandsStart(commands: string[]): void {
    console.log(chalk.magenta(`Post-commands (${commands.length})`));
  }

  postCommandsComplete(durationMs: number): void {
    console.log(`  ${chalk.green('ok')} ${chalk.gray(formatDuration(durationMs))}`);
  }

  postCommandsWarning(message: string): void {
    console.log(`  ${chalk.yellow('warning')} ${chalk.yellow(oneLine(message))}`);
  }

  resultSubmitted(status: string): void {
    console.log(chalk.green(`Result submitted: ${status}`));
  }

  warning(message: string): void {
    console.log(chalk.yellow(`Warning: ${message}`));
  }

  info(message: string): void {
    console.log(chalk.gray(message));
  }

  complete(state: TerminalState): void {
    console.log('');

    if (state.receipt) {
      const receipt = state.receipt;
      const label = state.status === 'completed'
        ? chalk.green.bold('RUN COMPLETED')
        : chalk.red.bold('RUN FAILED');

      console.log(label);
      console.log(`  Status:    ${chalk.cyan(receipt.status)}`);
      console.log(`  Steps:     ${chalk.cyan(`${receipt.steps_passed}/${receipt.total_steps} passed`)}`);
      console.log(`  Failed:    ${chalk.cyan(String(receipt.steps_failed))}`);
      console.log(`  Chain:     ${chalk.cyan(shortHash(receipt.chain_hash ?? 'unknown'))}`);
      console.log(`  Finished:  ${chalk.cyan(receipt.completed_at ?? 'unknown')}`);
      return;
    }

    const label = state.status === 'completed'
      ? chalk.green.bold('RUN COMPLETED')
      : chalk.red.bold('RUN FAILED');

    console.log(label);
    console.log(`  Finished:  ${chalk.cyan(state.completedAt ?? 'unknown')}`);
    console.log(`  Receipt:   ${chalk.yellow('not returned by server')}`);
  }
}
