#!/usr/bin/env node

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import * as yaml from 'js-yaml';

import { executeLockstep } from '../core/executor.js';
import type { CLIOptions } from '../core/executor.js';
import { parseSpec, validateSpec } from '../core/parser.js';
import { computeStepHash } from '../core/hasher.js';
import type { LockstepReceipt } from '../core/hasher.js';
import { TerminalReporter } from '../reporters/terminal.js';
import { getLockstepVersion } from '../utils/version.js';
import { hashFileBytes } from '../utils/crypto.js';
import {
  LockstepError,
  SpecValidationError,
} from '../utils/errors.js';
import { generateSpecs } from '../generators/spec-generator.js';
import type { LockstepPolicy, LockstepPolicyMode } from '../policy/types.js';
import { generatePolicyDraft, type PolicyDraftIntent } from '../policy/draft.js';
import { buildContractGenerationPrompt, type ContractDraftAnswers } from '../product/contract.js';
import { buildDefaultsSummary, buildPolicySummary, buildSpecSummary } from '../product/review.js';
import {
  getContractRigorProfile,
  getWorkflowPreset,
  listContractRigorIds,
  listWorkflowPresetIds,
  type ContractRigor,
  type WorkflowPreset,
} from '../product/presets.js';
import { getPublicSignalName } from '../core/public-surface.js';
import { DEFAULTS, loadRC, saveRC, type LockstepRC } from '../utils/config.js';
import {
  detectAvailableProviders,
  detectBinary,
  detectClaudeAuthModes,
  isProviderName,
  type ClaudeAuthMode,
  type ProviderName,
} from '../utils/providers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SPEC = '.lockstep.yml';
const SEPARATOR = chalk.gray('\u2501'.repeat(39));

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

interface TemplateInfo {
  name: string;
  file: string;
  description: string;
}

const TEMPLATES: TemplateInfo[] = [
  {
    name: 'blank',
    file: 'blank.yml',
    description: 'Empty starter template with a single example step',
  },
  {
    name: 'nextjs-saas',
    file: 'nextjs-saas.yml',
    description: 'Full-stack Next.js SaaS with auth, database, and dashboard',
  },
  {
    name: 'rest-api',
    file: 'rest-api.yml',
    description: 'Express.js REST API with TypeScript, CRUD, and tests',
  },
  {
    name: 'solana-program',
    file: 'solana-program.yml',
    description: 'Solana on-chain program using the Anchor framework',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the absolute path to the templates/ directory relative to the
 * package root (works in both source and compiled dist/).
 */
function resolveTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // In source: src/bin/lockstep.ts -> ../../templates
  // In dist:   dist/bin/lockstep.js -> ../../templates
  let dir = path.dirname(thisFile);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'templates');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the expected relative path
  return path.resolve(path.dirname(thisFile), '..', '..', 'templates');
}

/**
 * Truncates a hash for display: first 8 chars.
 */
function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return hash.slice(0, 12) + '...';
}

/**
 * Prompt the user interactively and return the answer.
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptChoice<T extends string>(
  label: string,
  options: T[],
  fallback: T,
): Promise<T> {
  const rendered = options
    .map((option) => option === fallback ? `${option}*` : option)
    .join('/');

  while (true) {
    const answer = (await prompt(`${label} [${rendered}] `)).trim().toLowerCase();
    if (!answer) {
      return fallback;
    }

    const matched = options.find((option) => option.toLowerCase() === answer);
    if (matched) {
      return matched;
    }
  }
}

async function promptYesNo(
  question: string,
  fallback = false,
): Promise<boolean> {
  const suffix = fallback ? ' [Y/n] ' : ' [y/N] ';

  while (true) {
    const answer = (await prompt(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) {
      return fallback;
    }

    if (answer === 'y' || answer === 'yes') {
      return true;
    }

    if (answer === 'n' || answer === 'no') {
      return false;
    }
  }
}

function applyDefaultsToSpecFile(specPath: string, rc: LockstepRC): void {
  const parsed = yaml.load(readFileSync(specPath, 'utf-8')) as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }

  const configValue = parsed.config;
  const config = (configValue && typeof configValue === 'object' && !Array.isArray(configValue))
    ? { ...configValue as Record<string, unknown> }
    : {};

  config.agent = rc.agent ?? DEFAULTS.agent;

  if (rc.agent_model) {
    config.agent_model = rc.agent_model;
  }

  if (rc.execution_mode) {
    config.execution_mode = rc.execution_mode;
  }

  if (rc.judge_mode) {
    config.judge_mode = rc.judge_mode;
  }

  if (rc.judge_model) {
    config.judge_model = rc.judge_model;
  }

  if (rc.claude_auth_mode) {
    config.claude_auth_mode = rc.claude_auth_mode;
  }

  parsed.config = config;
  writeFileSync(specPath, yaml.dump(parsed, { lineWidth: 120 }), 'utf-8');
}

/**
 * Prints a fatal error and exits.
 */
function fatal(message: string, details?: string[]): never {
  console.error('');
  console.error(chalk.red.bold('Error: ') + message);
  if (details && details.length > 0) {
    for (const d of details) {
      console.error(chalk.red('  ' + d));
    }
  }
  console.error('');
  process.exit(1);
}

function findPolicyFile(workingDirectory = process.cwd()): string | null {
  for (const filename of ['.lockstep-policy.yml', '.lockstep-policy.yaml', 'lockstep-policy.yml']) {
    const fullPath = path.join(workingDirectory, filename);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

function parseProviderOrUndefined(value: unknown): ProviderName | undefined {
  return isProviderName(value) ? value : undefined;
}

async function runPolicyInitWizard(workingDirectory = process.cwd()): Promise<void> {
  const current = loadRC();
  const availableProviders = detectAvailableProviders();
  const existingPolicyPath = findPolicyFile(workingDirectory);
  const existingPolicy = existingPolicyPath
    ? yaml.load(readFileSync(existingPolicyPath, 'utf-8')) as LockstepPolicy | undefined
    : undefined;

  console.log('');
  console.log(chalk.bold('Lockstep Policy Setup'));
  console.log(SEPARATOR);
  console.log('');
  console.log(chalk.gray('Describe the boundaries once. Lockstep will draft the YAML and show it before writing.'));
  console.log('');

  const projectSummary = await prompt('Project summary (stack, repo shape, or workflow): ');
  const policyBrief = await prompt('Policy brief in plain English: ');
  const neverDo = await prompt('Never do (commands/actions, comma-separated or plain sentence): ');
  const requireApproval = await prompt('Require approval for (comma-separated or plain sentence): ');
  const protectedPaths = await prompt('Protected paths (comma-separated globs, Enter to skip): ');
  const writablePaths = await prompt('Normal writable paths (comma-separated globs, Enter to let Lockstep infer): ');
  const networkDomains = await prompt('Allowed network domains (comma-separated, Enter for none): ');
  const networkBlockAllOther = networkDomains.trim().length > 0
    ? await promptYesNo('Block all other outbound domains?', true)
    : false;

  console.log('');
  console.log(chalk.gray('Policy modes: strict = human approval, review = AI review then escalate, yolo = allow and log.'));
  const mode = await promptChoice<LockstepPolicyMode>(
    'Policy mode',
    ['strict', 'review', 'yolo'],
    existingPolicy?.mode ?? 'review',
  );

  const defaultDraftProvider = parseProviderOrUndefined(existingPolicy?.review?.provider)
    ?? current.judge_mode
    ?? current.agent
    ?? availableProviders[0]
    ?? 'codex';
  const canPromptProvider = availableProviders.length > 0;
  const draftProvider = canPromptProvider
    ? await promptChoice<ProviderName>(
        mode === 'strict' ? 'Draft with provider' : 'Policy review provider',
        availableProviders,
        availableProviders.includes(defaultDraftProvider) ? defaultDraftProvider : availableProviders[0],
      )
    : defaultDraftProvider;
  const reviewModel = mode !== 'strict' || canPromptProvider
    ? await prompt(
        `${mode === 'strict' ? 'Draft' : 'Policy review'} model override (Enter for provider default/latest${existingPolicy?.review?.model ? `, current: ${existingPolicy.review.model}` : ''}): `,
      )
    : '';

  const intent: PolicyDraftIntent = {
    projectSummary,
    policyBrief,
    neverDo,
    requireApproval,
    protectedPaths,
    writablePaths,
    networkDomains,
    networkBlockAllOther,
    mode,
    reviewProvider: draftProvider,
    ...(reviewModel.trim() ? { reviewModel: reviewModel.trim() } : {}),
  };

  const draft = generatePolicyDraft(intent, workingDirectory);
  const targetPath = path.join(workingDirectory, '.lockstep-policy.yml');

  console.log('');
  console.log(chalk.bold('Draft Summary'));
  console.log(SEPARATOR);
  console.log(draft.summary);
  console.log('');
  console.log(chalk.bold('Draft YAML'));
  console.log(SEPARATOR);
  console.log(chalk.cyan(draft.yaml));
  console.log('');

  if (existingPolicyPath && path.resolve(existingPolicyPath) !== path.resolve(targetPath)) {
    console.log(chalk.gray(`Existing policy found at ${existingPolicyPath}. The new draft will be written to ${targetPath}.`));
    console.log('');
  }

  const shouldWrite = await promptYesNo(
    existsSync(targetPath)
      ? `Overwrite ${path.relative(process.cwd(), targetPath) || '.lockstep-policy.yml'}?`
      : `Write ${path.relative(process.cwd(), targetPath) || '.lockstep-policy.yml'} now?`,
    true,
  );

  if (!shouldWrite) {
    console.log('');
    console.log(chalk.gray('Policy draft not written.'));
    console.log('');
    return;
  }

  writeFileSync(targetPath, `${draft.yaml}\n`, 'utf-8');

  console.log('');
  console.log(chalk.green.bold(`Saved ${path.relative(process.cwd(), targetPath) || '.lockstep-policy.yml'}`));
  console.log(chalk.gray(`Draft source: ${draft.source}`));
  console.log(chalk.gray('Review it with `lockstep policy` before your first run.'));
  console.log('');
}

async function showPolicyStatus(): Promise<void> {
  const fs = await import('node:fs');
  const { PolicyEngine } = await import('../policy/engine.js');

  console.log('');
  console.log(chalk.bold('Lockstep Policy'));
  console.log(SEPARATOR);
  console.log('');

  const policyPath = findPolicyFile();
  if (policyPath) {
    console.log(chalk.white(`  Policy: ${path.relative(process.cwd(), policyPath) || policyPath}`));
    const policy = yaml.load(fs.readFileSync(policyPath, 'utf-8')) as LockstepPolicy;
    console.log(chalk.gray(`  Mode: ${policy?.mode ?? 'strict'}`));
    if (policy?.review && policy.mode !== 'strict') {
      console.log(chalk.gray(`  Review provider: ${policy.review.provider ?? 'codex'}`));
      console.log(chalk.gray(`  Review threshold: ${policy.review.threshold ?? 8}`));
      if (policy.review.model) {
        console.log(chalk.gray(`  Review model: ${policy.review.model}`));
      }
    }
    if (policy?.shell?.deny?.length) {
      console.log(chalk.gray(`  Shell deny: ${policy.shell.deny.length} patterns`));
    }
    if (policy?.shell?.require_approval?.length) {
      console.log(chalk.gray(`  Shell require approval: ${policy.shell.require_approval.length} patterns`));
    }
    if (policy?.filesystem?.protected?.length) {
      console.log(chalk.gray(`  Protected paths: ${policy.filesystem.protected.length}`));
    }
  } else {
    console.log(chalk.gray('  No custom policy found. Built-in safety rules active.'));
  }

  const engine = new PolicyEngine({}, process.cwd());
  const pending = engine.getPending();
  if (pending.length > 0) {
    console.log('');
    console.log(chalk.yellow(`Pending approvals: ${pending.length}`));
    for (const p of pending) {
      console.log(`  ${chalk.cyan(p.id)}  ${p.tool}  ${chalk.gray(p.reason)}`);
      console.log(chalk.gray(`    Approve: lockstep approve ${p.id}`));
    }
  }

  const logFile = '.lockstep/policy-log.jsonl';
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-5).map((line) => JSON.parse(line) as { action?: string; allowed?: boolean; reason?: string });
    if (recent.length > 0) {
      console.log('');
      console.log(chalk.bold('Recent decisions'));
      for (const entry of recent) {
        const icon = entry.allowed ? chalk.green('ALLOW') : chalk.red('BLOCK');
        console.log(`  ${icon} ${entry.action ?? 'unknown action'}`);
        if (entry.reason) {
          console.log(chalk.gray(`    ${entry.reason}`));
        }
      }
    }
  }

  console.log('');
}

async function showWorkspaceReview(
  specFile = DEFAULT_SPEC,
  raw = false,
): Promise<void> {
  const rc = loadRC();
  const specPath = path.resolve(specFile);
  const workspaceDir = existsSync(specPath)
    ? path.dirname(specPath)
    : process.cwd();
  const policyPath = findPolicyFile(workspaceDir);
  const policy = policyPath
    ? yaml.load(readFileSync(policyPath, 'utf-8')) as LockstepPolicy | undefined
    : undefined;

  console.log('');
  console.log(chalk.bold('Lockstep Review'));
  console.log(SEPARATOR);
  console.log('');

  console.log(chalk.white('Defaults'));
  for (const line of buildDefaultsSummary(rc)) {
    console.log(chalk.gray(`  ${line}`));
  }
  console.log('');

  console.log(chalk.white('Policy'));
  console.log(chalk.gray(`  File: ${policyPath ? path.relative(process.cwd(), policyPath) || policyPath : 'none'}`));
  for (const line of buildPolicySummary(policy)) {
    console.log(chalk.gray(`  ${line}`));
  }
  console.log('');

  if (existsSync(specPath)) {
    const spec = parseSpec(specPath);
    console.log(chalk.white('Contract'));
    console.log(chalk.gray(`  File: ${path.relative(process.cwd(), specPath) || specPath}`));
    for (const line of buildSpecSummary(spec)) {
      console.log(chalk.gray(`  ${line}`));
    }
    console.log('');

    if (raw) {
      console.log(chalk.white('Raw Spec'));
      console.log(SEPARATOR);
      console.log(readFileSync(specPath, 'utf-8').trim());
      console.log('');
    }
  } else {
    console.log(chalk.white('Contract'));
    console.log(chalk.gray(`  No spec found at ${specPath}`));
    console.log(chalk.gray(`  Draft one with lockstep contract init or lockstep init.`));
    console.log('');
  }

  if (raw && policyPath) {
    console.log(chalk.white('Raw Policy'));
    console.log(SEPARATOR);
    console.log(readFileSync(policyPath, 'utf-8').trim());
    console.log('');
  }

  console.log(chalk.white('Next'));
  console.log(chalk.gray('  lockstep policy init      Draft or update repo guardrails'));
  console.log(chalk.gray('  lockstep contract init    Draft a strict contract from plain-English intent'));
  console.log(chalk.gray(`  lockstep run ${specFile === DEFAULT_SPEC ? '' : specFile}`.trim()));
  console.log('');
}

type PersistGeneratedSpecsOptions = {
  dryRun?: boolean;
  output?: string;
};

async function persistGeneratedSpecs(
  result: Awaited<ReturnType<typeof generateSpecs>>,
  opts: PersistGeneratedSpecsOptions,
): Promise<void> {
  console.log('');

  const tempDir = path.join(process.cwd(), '.lockstep', 'tmp');
  const { mkdirSync: mkdir } = await import('node:fs');
  mkdir(tempDir, { recursive: true });

  let allValid = true;

  for (const spec of result.specs) {
    const tempPath = path.join(tempDir, spec.filename);
    mkdir(path.dirname(tempPath), { recursive: true });
    writeFileSync(tempPath, spec.content, 'utf-8');

    const validationResult = validateSpec(tempPath);
    if (validationResult.valid) {
      console.log(`  ${chalk.green('\u2713')} ${spec.filename} validated`);
    } else {
      allValid = false;
      console.log(`  ${chalk.red('\u2718')} ${spec.filename} has validation errors:`);
      if (validationResult.errors) {
        for (const err of validationResult.errors) {
          console.log(`    ${chalk.red(err)}`);
        }
      }
    }

    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(tempPath);
    } catch {
      // ignore temp cleanup failure
    }
  }

  if (!allValid) {
    console.log('');
    console.log(chalk.yellow('  Generated spec(s) have validation errors. You may need to edit them manually.'));
  }

  if (opts.dryRun) {
    console.log('');
    console.log(chalk.gray('  --dry-run: not writing files'));
    console.log('');

    if (result.specs.length === 1) {
      console.log(chalk.gray('  Generated YAML:'));
      console.log('');
      console.log(result.specs[0].content);
    }
    return;
  }

  const defaults = loadRC();
  console.log('');

  for (const spec of result.specs) {
    const targetPath = opts.output && result.specs.length === 1
      ? path.resolve(opts.output)
      : path.resolve(spec.filename);

    if (existsSync(targetPath)) {
      const answer = await prompt(
        chalk.yellow(`  ${path.basename(targetPath)} already exists. Overwrite? [y/N] `),
      );
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.gray(`  Skipped ${path.basename(targetPath)}`));
        continue;
      }
    }

    mkdir(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, spec.content, 'utf-8');
    applyDefaultsToSpecFile(targetPath, defaults);
    console.log(`  ${chalk.green('\u2713')} Written to ${chalk.cyan(targetPath)}`);
  }

  console.log('');

  if (result.multiFile) {
    console.log('  Run in order:');
    for (const spec of result.specs) {
      console.log(`    ${chalk.cyan(`lockstep run ${spec.filename}`)}`);
    }
    console.log('');
    console.log(`  Review the contract with ${chalk.cyan(`lockstep review ${result.specs[0].filename}`)}.`);
    console.log('');
    console.log('  Or run all sequentially:');
    const specFiles = result.specs.map((s) => s.filename).join(' ');
    console.log(`    ${chalk.cyan(`lockstep run-all ${specFiles}`)}`);
  } else {
    const specFile = result.specs[0].filename;
    console.log(`  Next: ${chalk.cyan(`lockstep review ${specFile === '.lockstep.yml' ? '' : specFile}`.trim())}`);
    console.log(`        ${chalk.cyan(`lockstep run ${specFile === '.lockstep.yml' ? '' : specFile}`.trim())}`);
  }
  console.log('');
}

async function runContractInitWizard(opts: PersistGeneratedSpecsOptions = {}): Promise<void> {
  const rc = loadRC();
  const policyPath = findPolicyFile();
  const policy = policyPath
    ? yaml.load(readFileSync(policyPath, 'utf-8')) as LockstepPolicy | undefined
    : undefined;

  console.log('');
  console.log(chalk.bold('Lockstep Contract Setup'));
  console.log(SEPARATOR);
  console.log('');
  console.log(chalk.gray('Describe the outcome and Lockstep will draft the execution contract from it.'));
  console.log('');

  const workflowPreset = await promptChoice<WorkflowPreset>(
    'Workflow preset',
    listWorkflowPresetIds(),
    rc.workflow_preset ?? 'guarded',
  );
  const rigor = await promptChoice<ContractRigor>(
    'Delivery rigor',
    listContractRigorIds(),
    rc.contract_rigor ?? 'production',
  );
  const projectSummary = await prompt('Project summary (stack, repo shape, product surface): ');
  const objective = await prompt('Objective or outcome for this contract: ');
  if (!objective.trim()) {
    fatal('Objective is required to draft a contract.');
  }
  const deliverables = await prompt('Required deliverables (comma-separated, Enter to skip): ');
  const mustPass = await prompt('Must-pass commands or checks (comma-separated, Enter to skip): ');
  const constraints = await prompt('Additional constraints, architecture rules, or non-goals: ');

  const answers: ContractDraftAnswers = {
    projectSummary,
    objective,
    deliverables,
    mustPass,
    constraints,
    workflowPreset,
    rigor,
  };

  const workflow = getWorkflowPreset(workflowPreset);
  const rigorProfile = getContractRigorProfile(rigor);

  console.log('');
  console.log(chalk.bold('Contract Summary'));
  console.log(SEPARATOR);
  console.log(chalk.gray(`Workflow: ${workflow.label} — ${workflow.description}`));
  console.log(chalk.gray(`Rigor: ${rigorProfile.label} — ${rigorProfile.description}`));
  console.log('');

  const generationPrompt = buildContractGenerationPrompt(answers, process.cwd(), policy);
  const ora = (await import('ora')).default;
  const spinner = ora({
    text: chalk.blue('Drafting Lockstep contract...'),
    prefixText: ' ',
    indent: 2,
  }).start();

  let lineCount = 0;
  try {
    const result = await generateSpecs(generationPrompt, {
      callbacks: {
        onOutput: () => {
          lineCount++;
          spinner.text = chalk.blue(`Drafting Lockstep contract... ${chalk.gray(`[${lineCount} chunks]`)}`);
        },
        onRetry: ({ attempt, maxAttempts }) => {
          spinner.text = chalk.yellow(`Repairing generated contract... ${chalk.gray(`[attempt ${attempt}/${maxAttempts}]`)}`);
        },
      },
    });
    spinner.stop();

    if (result.multiFile) {
      console.log('');
      console.log(`  ${chalk.yellow('Detected high complexity')} — split into ${chalk.cyan(String(result.specs.length))} specs.`);
    } else {
      console.log('');
      console.log(`  Drafted ${chalk.cyan(`${result.specs[0].stepCount}-phase`)} contract.`);
    }

    await persistGeneratedSpecs(result, opts);
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    fatal(`Contract drafting failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('lockstep')
  .description('Cryptographic verification for AI coding agents')
  .version(getLockstepVersion(), '-v, --version');

// ---------------------------------------------------------------------------
// lockstep run [spec-file]
// ---------------------------------------------------------------------------

program
  .command('run')
  .description('Execute a Lockstep plan and generate a verified receipt')
  .argument('[spec-file]', 'path to spec file', DEFAULT_SPEC)
  .option('--dry-run', 'validate spec and show plan without executing')
  .option('--phase <n>', 'run only phase N (1-indexed)', Number.parseInt)
  .option('--from-phase <n>', 'start execution from phase N (1-indexed)', Number.parseInt)
  .option('--verbose', 'show detailed output')
  .option('--no-color', 'disable colored output')
  .option('--output <path>', 'custom output directory for receipt files')
  .addOption(new Option('--step <n>', 'run only step N (1-indexed)').argParser(Number.parseInt).hideHelp())
  .addOption(new Option('--from <n>', 'start execution from step N (1-indexed)').argParser(Number.parseInt).hideHelp())
  .action(async (specFile: string, opts: Record<string, unknown>) => {
    const specPath = path.resolve(specFile);

    if (!existsSync(specPath)) {
      fatal(
        `Spec file not found: ${specFile}`,
        [
          `Looked for: ${specPath}`,
          `Run ${chalk.cyan('lockstep init')} to create a new spec file.`,
        ],
      );
    }

    const cliOptions: CLIOptions = {
      dryRun: opts.dryRun as boolean | undefined,
      step: (opts.phase as number | undefined) ?? (opts.step as number | undefined),
      from: (opts.fromPhase as number | undefined) ?? (opts.from as number | undefined),
      verbose: opts.verbose as boolean | undefined,
      output: opts.output as string | undefined,
    };

    // Disable chalk colors if --no-color is set
    if (opts.color === false) {
      chalk.level = 0;
    }

    const reporter = new TerminalReporter(cliOptions.output, cliOptions.verbose);

    try {
      const receipt = await executeLockstep(specPath, cliOptions, reporter);

      if (receipt.status === 'failed') {
        process.exit(1);
      }

      process.exit(0);
    } catch (err) {
      if (err instanceof SpecValidationError) {
        console.error('');
        console.error(chalk.red.bold('Spec Validation Failed'));
        console.error(chalk.red(err.message));
        if (err.details) {
          for (const d of err.details) {
            console.error(chalk.red('  ' + d));
          }
        }
        console.error('');
        process.exit(1);
      }

      if (err instanceof LockstepError) {
        fatal(err.message);
      }

      const message = err instanceof Error ? err.message : String(err);
      fatal(`Unexpected error: ${message}`);
    }
  });

// ---------------------------------------------------------------------------
// lockstep validate [spec-file]
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate a Lockstep plan file without running it')
  .argument('[spec-file]', 'path to spec file', DEFAULT_SPEC)
  .action((specFile: string) => {
    const specPath = path.resolve(specFile);

    if (!existsSync(specPath)) {
      fatal(
        `Spec file not found: ${specFile}`,
        [`Looked for: ${specPath}`],
      );
    }

    const result = validateSpec(specPath);

    console.log('');
    if (result.valid) {
      // Parse again to show summary info
      const spec = parseSpec(specPath);
      console.log(chalk.green.bold('\u2705 Valid') + chalk.gray(` \u2014 ${specPath}`));
      console.log('');
      console.log(`  Phases:           ${chalk.cyan(String(spec.steps.length))}`);
      console.log(`  Runner:           ${chalk.cyan(spec.config.agent)}`);
      console.log(`  Effort budget:    ${chalk.cyan(String(spec.config.max_retries))}`);
      console.log(`  Phase timeout:    ${chalk.cyan(spec.config.step_timeout + 's')}`);
      console.log(`  Workspace:        ${chalk.cyan(spec.config.working_directory)}`);
      console.log('');
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];
        const signals = step.validate.map((v) => getPublicSignalName(v.type)).join(', ');
        console.log(`  ${chalk.bold(`Phase ${i + 1}:`)} ${step.name}`);
        console.log(`    Signals: ${chalk.gray(signals)}`);
      }
      console.log('');
      process.exit(0);
    } else {
      console.log(chalk.red.bold('\u274C Invalid') + chalk.gray(` \u2014 ${specPath}`));
      console.log('');
      if (result.errors) {
        for (const err of result.errors) {
          console.log(chalk.red('  \u2022 ' + err));
        }
      }
      console.log('');
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// lockstep init [template]
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Create a new .lockstep.yml spec from a template')
  .argument('[template]', 'template name', 'blank')
  .action(async (templateName: string) => {
    const templatesDir = resolveTemplatesDir();
    const template = TEMPLATES.find((t) => t.name === templateName);

    if (!template) {
      console.error('');
      console.error(
        chalk.red.bold('Error: ') +
        `Unknown template "${templateName}"`,
      );
      console.error('');
      console.error('Available templates:');
      for (const t of TEMPLATES) {
        console.error(`  ${chalk.cyan(t.name.padEnd(20))} ${chalk.gray(t.description)}`);
      }
      console.error('');
      console.error(`Usage: ${chalk.cyan('lockstep init <template>')}`);
      console.error('');
      process.exit(1);
    }

    const templatePath = path.join(templatesDir, template.file);

    if (!existsSync(templatePath)) {
      fatal(
        `Template file not found: ${templatePath}`,
        ['This may indicate a broken installation. Try reinstalling lockstep.'],
      );
    }

    const targetPath = path.resolve(DEFAULT_SPEC);

    if (existsSync(targetPath)) {
      const answer = await prompt(
        chalk.yellow(`\u26A0\uFE0F  ${DEFAULT_SPEC} already exists. Overwrite? [y/N] `),
      );
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.gray('Aborted.'));
        process.exit(0);
      }
    }

    copyFileSync(templatePath, targetPath);
    applyDefaultsToSpecFile(targetPath, loadRC());

    console.log('');
    console.log(
      chalk.green.bold('\u2705 Created ') +
      chalk.cyan(DEFAULT_SPEC) +
      chalk.gray(` from template "${templateName}"`),
    );
    console.log('');
    console.log(`Next steps:`);
    console.log(`  1. Edit ${chalk.cyan(DEFAULT_SPEC)} to define your phases and signals, or use ${chalk.cyan('lockstep contract init')} for guided drafting`);
    console.log(`  2. Run  ${chalk.cyan('lockstep policy init')} to draft guardrails for this repo`);
    console.log(`  3. Run  ${chalk.cyan('lockstep review')} to inspect the workflow, policy, and contract`);
    console.log(`  4. Run  ${chalk.cyan('lockstep validate')} to check your plan`);
    console.log(`  5. Run  ${chalk.cyan('lockstep run')} to execute`);
    console.log('');
  });

// ---------------------------------------------------------------------------
// lockstep verify <receipt-file>
// ---------------------------------------------------------------------------

program
  .command('verify')
  .description('Verify the integrity of a Lockstep receipt')
  .argument('<receipt-file>', 'path to receipt JSON file')
  .action((receiptFile: string) => {
    const receiptPath = path.resolve(receiptFile);

    if (!existsSync(receiptPath)) {
      fatal(`Receipt file not found: ${receiptFile}`, [`Looked for: ${receiptPath}`]);
    }

    // -----------------------------------------------------------------------
    // Parse receipt
    // -----------------------------------------------------------------------

    let receipt: LockstepReceipt;
    try {
      const raw = readFileSync(receiptPath, 'utf-8');
      receipt = JSON.parse(raw) as LockstepReceipt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fatal(`Failed to parse receipt: ${message}`);
    }

    // -----------------------------------------------------------------------
    // Verification state
    // -----------------------------------------------------------------------

    let allValid = true;
    const issues: string[] = [];

    // -----------------------------------------------------------------------
    // Header
    // -----------------------------------------------------------------------

    console.log('');
    console.log(chalk.bold('\uD83D\uDD12 Lockstep Receipt Verification'));
    console.log(SEPARATOR);
    console.log(`\uD83D\uDCC4 Receipt: ${chalk.cyan(receiptFile)}`);
    console.log(`\uD83D\uDCCB Spec:    ${chalk.cyan(receipt.spec_file)}`);
    console.log('');

    // -----------------------------------------------------------------------
    // Verify hash algorithm and canonicalization
    // -----------------------------------------------------------------------

    if (receipt.hash_algorithm !== 'sha256') {
      allValid = false;
      issues.push(`Unsupported hash algorithm: ${receipt.hash_algorithm}`);
      console.log(`Hash algorithm:  ${chalk.red('\u274C unsupported')} (${receipt.hash_algorithm})`);
    }

    if (receipt.canonicalization !== 'json-stable-stringify') {
      allValid = false;
      issues.push(`Unsupported canonicalization: ${receipt.canonicalization}`);
      console.log(`Canonicalization: ${chalk.red('\u274C unsupported')} (${receipt.canonicalization})`);
    }

    // -----------------------------------------------------------------------
    // Verify spec hash
    // -----------------------------------------------------------------------

    const specFilePath = path.resolve(path.dirname(receiptPath), receipt.spec_file);

    if (existsSync(specFilePath)) {
      const currentSpecHash = hashFileBytes(specFilePath);
      if (currentSpecHash === receipt.spec_hash) {
        console.log(`Spec hash:       ${chalk.green('\u2705 matches')}`);
      } else {
        allValid = false;
        issues.push('Spec file hash does not match receipt');
        console.log(`Spec hash:       ${chalk.red('\u274C mismatch')}`);
        console.log(chalk.gray(`  expected: ${receipt.spec_hash}`));
        console.log(chalk.gray(`  current:  ${currentSpecHash}`));
      }
    } else {
      console.log(`Spec hash:       ${chalk.yellow('\u26A0\uFE0F  spec file not found')}`);
      console.log(chalk.gray(`  looked for: ${specFilePath}`));
    }

    // -----------------------------------------------------------------------
    // Verify phase chain integrity
    // -----------------------------------------------------------------------

    const stepProofs = receipt.step_proofs;
    const totalSteps = stepProofs.length;
    let chainValid = true;
    let previousStepHash = 'genesis';

    if (totalSteps === 0) {
      console.log(`Chain integrity: ${chalk.yellow('\u26A0\uFE0F  no phase proofs to verify')}`);
    } else {
      // Verify each phase
      const stepResults: Array<{ index: number; valid: boolean; hash: string; error?: string }> = [];

      for (let i = 0; i < totalSteps; i++) {
        const proof = stepProofs[i];

        // Verify chain link: previous_step_hash must match
        if (proof.previous_step_hash !== previousStepHash) {
          chainValid = false;
          allValid = false;
          const errorMsg = `Phase ${i + 1} previous_step_hash mismatch`;
          issues.push(errorMsg);
          stepResults.push({
            index: i,
            valid: false,
            hash: proof.step_hash,
            error: `chain link broken (expected prev=${shortHash(previousStepHash)}, got ${shortHash(proof.previous_step_hash)})`,
          });
          previousStepHash = proof.step_hash;
          continue;
        }

        // Recompute phase hash
        const recomputed = computeStepHash(proof);

        if (recomputed === proof.step_hash) {
          stepResults.push({
            index: i,
            valid: true,
            hash: proof.step_hash,
          });
        } else {
          chainValid = false;
          allValid = false;
          const errorMsg = `Phase ${i + 1} hash mismatch (expected ${shortHash(recomputed)}, got ${shortHash(proof.step_hash)})`;
          issues.push(errorMsg);
          stepResults.push({
            index: i,
            valid: false,
            hash: proof.step_hash,
            error: `hash mismatch (recomputed: ${shortHash(recomputed)})`,
          });
        }

        previousStepHash = proof.step_hash;
      }

      // Print chain integrity header
      if (chainValid) {
        console.log(`Chain integrity: ${chalk.green(`\u2705 all ${totalSteps} phase hashes valid`)}`);
      } else {
        console.log(`Chain integrity: ${chalk.red('\u274C corruption detected')}`);
      }

      // Print individual phase results
      for (const sr of stepResults) {
        const stepLabel = `  Phase ${sr.index + 1}/${totalSteps}:`;
        if (sr.valid) {
          console.log(`${stepLabel.padEnd(18)}${chalk.green('\u2705')} hash ${chalk.gray(shortHash(sr.hash))} verified`);
        } else {
          console.log(`${stepLabel.padEnd(18)}${chalk.red('\u274C')} ${sr.error}`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Verify chain hash
    // -----------------------------------------------------------------------

    if (totalSteps > 0) {
      const lastStepHash = stepProofs[totalSteps - 1].step_hash;
      if (receipt.chain_hash === lastStepHash) {
        console.log(`Chain hash:      ${chalk.green('\u2705')} ${chalk.gray(shortHash(receipt.chain_hash))}`);
      } else {
        allValid = false;
        issues.push('Chain hash does not match last phase hash');
        console.log(`Chain hash:      ${chalk.red('\u274C mismatch')}`);
        console.log(chalk.gray(`  receipt:   ${receipt.chain_hash}`));
        console.log(chalk.gray(`  expected:  ${lastStepHash}`));
      }
    } else if (receipt.chain_hash === 'genesis') {
      console.log(`Chain hash:      ${chalk.green('\u2705')} ${chalk.gray('genesis (no phases)')}`);
    } else {
      allValid = false;
      issues.push('Chain hash should be "genesis" when no phases are present');
      console.log(`Chain hash:      ${chalk.red('\u274C expected genesis')}`);
    }

    // -----------------------------------------------------------------------
    // Verify completeness
    // -----------------------------------------------------------------------

    if (totalSteps === receipt.total_steps) {
      console.log(`Completeness:    ${chalk.green(`\u2705 ${totalSteps}/${receipt.total_steps} phases present`)}`);
    } else {
      allValid = false;
      issues.push(`Phase count mismatch: ${totalSteps} proofs vs ${receipt.total_steps} declared`);
      console.log(`Completeness:    ${chalk.red(`\u274C ${totalSteps}/${receipt.total_steps} phases present`)}`);
    }

    // -----------------------------------------------------------------------
    // Final status
    // -----------------------------------------------------------------------

    console.log('');
    console.log(SEPARATOR);

    if (allValid) {
      console.log(`Status: ${chalk.green.bold('\u2705 VALID')} ${chalk.gray('\u2014 receipt is untampered')}`);
    } else {
      console.log(`Status: ${chalk.red.bold('\u274C INVALID')} ${chalk.gray('\u2014 receipt may have been tampered with')}`);
      console.log('');
      console.log(chalk.red('Failures:'));
      for (const issue of issues) {
        console.log(chalk.red(`  \u2022 ${issue}`));
      }
    }

    console.log('');

    process.exit(allValid ? 0 : 1);
  });

// ---------------------------------------------------------------------------
// lockstep templates
// ---------------------------------------------------------------------------

program
  .command('templates')
  .description('List available spec templates')
  .action(() => {
    console.log('');
    console.log(chalk.bold('Available Templates'));
    console.log(SEPARATOR);
    console.log('');

    const maxNameLen = Math.max(...TEMPLATES.map((t) => t.name.length));

    for (const t of TEMPLATES) {
      console.log(
        `  ${chalk.cyan(t.name.padEnd(maxNameLen + 2))} ${chalk.gray(t.description)}`,
      );
    }

    console.log('');
    console.log(`Usage: ${chalk.cyan('lockstep init <template>')}`);
    console.log('');
  });

// ---------------------------------------------------------------------------
// lockstep setup
// ---------------------------------------------------------------------------

program
  .command('setup')
  .description('Detect local AI CLIs, auth modes, and save default Lockstep settings')
  .action(async () => {
    const availableRunners = detectAvailableProviders();

    if (availableRunners.length === 0) {
      fatal(
        'No supported local AI CLI was detected.',
        [
          'Install Codex or Claude Code first, then rerun `lockstep setup`.',
        ],
      );
    }

    const current = loadRC();
    const defaultRunner = current.agent && availableRunners.includes(current.agent)
      ? current.agent
      : availableRunners.includes('codex')
        ? 'codex'
        : availableRunners[0];
    const defaultJudge = current.judge_mode && availableRunners.includes(current.judge_mode)
      ? current.judge_mode
      : defaultRunner;
    const detectedClaudeAuthModes = detectClaudeAuthModes();

    console.log('');
    console.log(chalk.bold('Lockstep Setup'));
    console.log(SEPARATOR);
    console.log('');
    console.log(chalk.gray('Choose how Lockstep should execute, review, and authenticate on this machine.'));
    console.log('');
    console.log(`  Codex   ${detectBinary('codex') ? chalk.green('installed') : chalk.gray('not found')}`);
    console.log(`  Claude  ${detectBinary('claude', '-v') ? chalk.green('installed') : chalk.gray('not found')}`);
    if (availableRunners.includes('claude')) {
      console.log(`  Claude auth  ${detectedClaudeAuthModes.length > 0 ? chalk.green(detectedClaudeAuthModes.join(', ')) : chalk.yellow('none detected')}`);
    }
    console.log('');

    const workflowPreset = await promptChoice<WorkflowPreset>(
      'Workflow preset',
      listWorkflowPresetIds(),
      current.workflow_preset ?? 'guarded',
    );
    const workflow = getWorkflowPreset(workflowPreset);
    const rigor = await promptChoice<ContractRigor>(
      'Default delivery rigor',
      listContractRigorIds(),
      current.contract_rigor ?? 'production',
    );
    const agent = await promptChoice('Default runner', availableRunners, defaultRunner);
    const judge_mode = await promptChoice('Default review provider', availableRunners, defaultJudge);
    const execution_mode = await promptChoice(
      'Default autonomy',
      ['standard', 'yolo'],
      current.execution_mode ?? workflow.executionMode,
    );
    let claude_auth_mode: ClaudeAuthMode | undefined = current.claude_auth_mode;
    if (agent === 'claude' || judge_mode === 'claude' || availableRunners.includes('claude')) {
      const claudeOptions = Array.from(new Set<ClaudeAuthMode>([
        'auto',
        ...detectedClaudeAuthModes,
        current.claude_auth_mode ?? 'auto',
      ]));
      claude_auth_mode = await promptChoice(
        'Claude auth mode',
        claudeOptions,
        claudeOptions.includes(current.claude_auth_mode ?? 'auto')
          ? (current.claude_auth_mode ?? 'auto')
          : 'auto',
      );
    }
    const agent_model = await prompt(
      `Runner model override (Enter for provider default/latest${current.agent_model ? `, current: ${current.agent_model}` : ''}): `,
    );
    const judge_model = await prompt(
      `Review model override (Enter for provider default/latest${current.judge_model ? `, current: ${current.judge_model}` : ''}): `,
    );

    const nextConfig: LockstepRC = {
      agent,
      judge_mode,
      execution_mode,
      workflow_preset: workflowPreset,
      contract_rigor: rigor,
      ...(agent_model ? { agent_model } : {}),
      ...(judge_model ? { judge_model } : {}),
      ...(claude_auth_mode ? { claude_auth_mode } : {}),
    };

    saveRC(nextConfig);

    console.log('');
    console.log(chalk.green.bold('Saved default CLI configuration'));
    console.log('');
    console.log(`  Runner:       ${chalk.cyan(nextConfig.agent)}`);
    console.log(`  Review:       ${chalk.cyan(nextConfig.judge_mode ?? nextConfig.agent ?? DEFAULTS.judge_mode)}`);
    console.log(`  Workflow:     ${chalk.cyan(getWorkflowPreset(nextConfig.workflow_preset).label)}`);
    console.log(`  Rigor:        ${chalk.cyan(getContractRigorProfile(nextConfig.contract_rigor).label)}`);
    console.log(`  Autonomy:     ${chalk.cyan(nextConfig.execution_mode ?? 'standard')}`);
    console.log(`  Runner model: ${chalk.cyan(nextConfig.agent_model ?? 'provider-default')}`);
    console.log(`  Review model: ${chalk.cyan(nextConfig.judge_model ?? 'provider-default')}`);
    console.log(`  Claude auth:  ${chalk.cyan(nextConfig.claude_auth_mode ?? 'auto')}`);
    console.log('');
    console.log(`New ${chalk.cyan('lockstep init')} specs will use these defaults.`);
    console.log(`Use ${chalk.cyan('lockstep contract init')} to draft a contract with the saved workflow and rigor presets.`);
    if (await promptYesNo('Draft a repo policy now?', false)) {
      await runPolicyInitWizard(process.cwd());
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// lockstep generate <prompt-file>
// ---------------------------------------------------------------------------

program
  .command('generate', { hidden: true })
  .description('Generate a Lockstep spec from a natural language prompt')
  .argument('<prompt-file>', 'path to a markdown/text file with requirements (use "-" for stdin)')
  .option('--output <path>', 'output path (default: .lockstep.yml or auto-named for multi-file)')
  .option('--timeout <seconds>', 'generation timeout in seconds', Number.parseInt)
  .option('--attempts <n>', 'maximum generation/repair attempts before failing', Number.parseInt)
  .option('--dry-run', 'show generated spec without writing to disk')
  .action(async (promptFile: string, opts: Record<string, unknown>) => {
    const ora = (await import('ora')).default;

    // -----------------------------------------------------------------------
    // Read prompt
    // -----------------------------------------------------------------------

    let promptText: string;

    if (promptFile === '-') {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      promptText = Buffer.concat(chunks).toString('utf-8');
    } else {
      const promptPath = path.resolve(promptFile);
      if (!existsSync(promptPath)) {
        fatal(`Prompt file not found: ${promptFile}`, [`Looked for: ${promptPath}`]);
      }
      promptText = readFileSync(promptPath, 'utf-8');
    }

    if (!promptText.trim()) {
      fatal('Prompt file is empty');
    }

    // -----------------------------------------------------------------------
    // Generate
    // -----------------------------------------------------------------------

    console.log('');
    console.log(chalk.bold('  LOCKSTEP GENERATE'));
    console.log(chalk.gray('\u2501'.repeat(50)));
    console.log(`  Prompt: ${chalk.cyan(promptFile === '-' ? 'stdin' : promptFile)} ${chalk.gray(`(${promptText.length.toLocaleString()} chars)`)}`);

    const spinner = ora({
      text: chalk.blue('Generating spec...'),
      prefixText: ' ',
      indent: 2,
    }).start();

    let lineCount = 0;

    try {
      const result = await generateSpecs(promptText, {
        timeoutMs: typeof opts.timeout === 'number' ? opts.timeout * 1000 : undefined,
        maxAttempts: opts.attempts as number | undefined,
        callbacks: {
          onOutput: () => {
            lineCount++;
            spinner.text = chalk.blue(`Generating spec... ${chalk.gray(`[${lineCount} chunks]`)}`);
          },
          onRetry: ({ attempt, maxAttempts }) => {
            spinner.text = chalk.yellow(`Repairing invalid YAML... ${chalk.gray(`[attempt ${attempt}/${maxAttempts}]`)}`);
          },
        },
      });

      spinner.stop();

      // -----------------------------------------------------------------------
      // Display results
      // -----------------------------------------------------------------------

      if (result.multiFile) {
        console.log('');
        console.log(`  ${chalk.yellow('Detected high complexity')} \u2014 split into ${chalk.cyan(String(result.specs.length))} specs:`);
        console.log('');

        for (let i = 0; i < result.specs.length; i++) {
          const spec = result.specs[i];
          const stepList = spec.stepNames.map((n) => chalk.gray(n)).join(', ');
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${chalk.bold(spec.filename)}  ${chalk.gray(`(${spec.stepCount} steps)`)}`);
          console.log(`     ${stepList}`);
        }
      } else {
        const spec = result.specs[0];
        console.log('');
        console.log(`  Generated ${chalk.cyan(`${spec.stepCount}-step`)} spec:`);
        console.log('');
        for (let i = 0; i < spec.stepNames.length; i++) {
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${spec.stepNames[i]}`);
        }
      }

      await persistGeneratedSpecs(result, {
        dryRun: opts.dryRun as boolean | undefined,
        output: opts.output as string | undefined,
      });

      process.exit(0);
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      fatal(`Generation failed: ${message}`);
    }
  });

// ---------------------------------------------------------------------------
// lockstep contract — guided contract drafting
// ---------------------------------------------------------------------------

const contractCommand = program
  .command('contract')
  .description('Draft or inspect Lockstep execution contracts');

contractCommand
  .command('init')
  .description('Draft a strict Lockstep contract from plain-English intent')
  .option('--dry-run', 'show generated contract without writing files')
  .option('--output <path>', 'output path when generating a single spec')
  .action(async (opts: { dryRun?: boolean; output?: string }) => {
    await runContractInitWizard({
      dryRun: opts.dryRun,
      output: opts.output,
    });
  });

// ---------------------------------------------------------------------------
// lockstep run-all <spec-files...>
// ---------------------------------------------------------------------------

program
  .command('run-all', { hidden: true })
  .description('Run multiple Lockstep specs sequentially, stopping on failure')
  .argument('<spec-files...>', 'paths to spec files in execution order')
  .option('--verbose', 'show detailed output')
  .option('--no-color', 'disable colored output')
  .option('--output <path>', 'custom output directory for receipt files')
  .action(async (specFiles: string[], opts: Record<string, unknown>) => {
    if (opts.color === false) {
      chalk.level = 0;
    }

    console.log('');
    console.log(chalk.bold('  LOCKSTEP RUN-ALL'));
    console.log(chalk.gray('\u2501'.repeat(50)));
    console.log(`  Specs: ${chalk.cyan(String(specFiles.length))}`);
    for (let i = 0; i < specFiles.length; i++) {
      console.log(`    ${chalk.cyan(`${i + 1}.`)} ${specFiles[i]}`);
    }
    console.log(chalk.gray('\u2501'.repeat(50)));

    // Validate all spec files exist first
    for (const specFile of specFiles) {
      const specPath = path.resolve(specFile);
      if (!existsSync(specPath)) {
        fatal(`Spec file not found: ${specFile}`, [`Looked for: ${specPath}`]);
      }
    }

    const results: Array<{ specFile: string; status: string }> = [];

    for (let i = 0; i < specFiles.length; i++) {
      const specFile = specFiles[i];
      const specPath = path.resolve(specFile);

      console.log('');
      console.log(chalk.bold(`  === Spec ${i + 1}/${specFiles.length}: ${specFile} ===`));

      const cliOptions: CLIOptions = {
        verbose: opts.verbose as boolean | undefined,
        output: opts.output as string | undefined,
      };

      const reporter = new TerminalReporter(cliOptions.output, cliOptions.verbose);

      try {
        const receipt = await executeLockstep(specPath, cliOptions, reporter);

        if (receipt.status === 'failed') {
          results.push({ specFile, status: 'failed' });
          console.log('');
          console.log(chalk.red.bold(`  Stopping: ${specFile} failed.`));

          // Show summary of what ran
          printRunAllSummary(results, specFiles.length);
          process.exit(1);
        }

        results.push({ specFile, status: receipt.status });
      } catch (err) {
        results.push({ specFile, status: 'error' });

        if (err instanceof SpecValidationError) {
          console.error(chalk.red.bold('Spec Validation Failed'));
          console.error(chalk.red(err.message));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
        }

        console.log('');
        console.log(chalk.red.bold(`  Stopping: ${specFile} errored.`));
        printRunAllSummary(results, specFiles.length);
        process.exit(1);
      }
    }

    // All passed
    printRunAllSummary(results, specFiles.length);
    process.exit(0);
  });

function printRunAllSummary(
  results: Array<{ specFile: string; status: string }>,
  totalSpecs: number,
): void {
  console.log('');
  console.log(chalk.gray('\u2501'.repeat(50)));
  console.log(chalk.bold('  Run-All Summary'));
  console.log(chalk.gray('\u2501'.repeat(50)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const icon = r.status === 'completed' || r.status === 'partial'
      ? chalk.green('\u2713')
      : chalk.red('\u2718');
    console.log(`  ${icon} ${r.specFile} ${chalk.gray(`(${r.status})`)}`);
  }

  // Show remaining unrun specs
  if (results.length < totalSpecs) {
    console.log(chalk.gray(`  ... ${totalSpecs - results.length} spec(s) not run`));
  }

  const passed = results.filter((r) => r.status === 'completed' || r.status === 'partial').length;
  const allDone = results.length === totalSpecs && passed === totalSpecs;

  console.log('');
  if (allDone) {
    console.log(chalk.green.bold(`  ALL ${totalSpecs} SPECS COMPLETED`));
  } else {
    console.log(chalk.red.bold(`  ${passed}/${totalSpecs} specs completed`));
  }
  console.log(chalk.gray('\u2501'.repeat(50)));
  console.log('');
}

// ---------------------------------------------------------------------------
// lockstep approve — approve a pending policy action
// ---------------------------------------------------------------------------

program
  .command('approve', { hidden: true })
  .description('Approve a pending policy action (shown when agent tries a restricted command)')
  .argument('<approval-id>', 'approval ID from the policy prompt')
  .action(async (approvalId: string) => {
    try {
      const { PolicyEngine } = await import('../policy/engine.js');
      const engine = new PolicyEngine({}, process.cwd());
      const success = engine.approve(approvalId);

      if (success) {
        console.log(chalk.green(`  Approved: ${approvalId}`));
        console.log(chalk.gray('  The agent will use this on the next retry.'));
      } else {
        console.log(chalk.red(`  Approval not found: ${approvalId}`));
        console.log(chalk.gray('  Check the ID from the policy prompt.'));

        // Show pending approvals
        const pending = engine.getPending();
        if (pending.length > 0) {
          console.log('');
          console.log(chalk.white('  Pending approvals:'));
          for (const p of pending) {
            console.log(chalk.gray(`    ${p.id}  ${p.action}`));
          }
        }
      }
    } catch (err) {
      console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// lockstep policy — inspect or draft the repo policy
// ---------------------------------------------------------------------------

const policyCommand = program
  .command('policy')
  .description('Inspect the active policy, approvals, or draft a new repo policy');

policyCommand
  .action(async () => {
    try {
      await showPolicyStatus();
    } catch (err) {
      console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

policyCommand
  .command('init')
  .description('Draft a .lockstep-policy.yml from plain-English intent')
  .action(async () => {
    try {
      await runPolicyInitWizard(process.cwd());
    } catch (err) {
      console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// lockstep review — explain the current workflow, policy, and contract
// ---------------------------------------------------------------------------

program
  .command('review')
  .description('Explain the active defaults, repo policy, and Lockstep contract')
  .argument('[spec-file]', 'path to spec file', DEFAULT_SPEC)
  .option('--raw', 'show raw YAML for the active spec and policy')
  .action(async (specFile: string, opts: { raw?: boolean }) => {
    try {
      await showWorkspaceReview(specFile, opts.raw === true);
    } catch (err) {
      console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Parse and execute
// ---------------------------------------------------------------------------

program.parse();
