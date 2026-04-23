import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { createAgent } from '../agents/factory.js';
import { loadPolicy } from '../policy/index.js';
import {
  LockstepApiClient,
  type NextResponse,
  type ValidationResult,
  type ValidatorConfig,
  type WorkspaceMetadata,
} from './api.js';
import { runAiJudge } from './ai-judge.js';
import {
  applyClaudeAuthMode,
  type RuntimeConfig,
} from './providers.js';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const DEFAULT_RUNNER_REASONING_EFFORT = 'medium';
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CLAUDE_RUNNER_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,LSP,TodoWrite';
const CLAUDE_ALLOWED_TOOL_RULES = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'LSP',
  'TodoWrite',
] as const;
const RUNNER_EXECUTION_RULES = [
  'Runner execution rules:',
  '- Run shell commands sequentially. Do not background them or launch build, lint, typecheck, test, clean, or watch commands in parallel.',
  '- After dependencies are installed, prefer project-local binaries or package-manager scripts over ad-hoc global tool invocations.',
  '- Unless the task explicitly calls for policy changes, preserve strict TypeScript, lint, and test rules. Fix the code or scripts instead of weakening the contract.',
].join('\n');

export interface LocalSpec {
  config?: {
    agent?: 'codex' | 'claude';
    agent_model?: string;
    execution_mode?: 'standard' | 'yolo';
    judge_mode?: 'codex' | 'claude';
    judge_model?: string;
    claude_auth_mode?: 'auto' | 'interactive' | 'api-key' | 'auth-token' | 'oauth-token' | 'bedrock' | 'vertex' | 'foundry';
  };
  steps: Array<{
    name: string;
    prompt: string;
    pre_commands?: string[];
    post_commands?: string[];
    validate: ValidatorConfig[];
  }>;
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

interface AgentResult {
  stdout: string;
  stderr: string;
}

interface ShellCommandResult {
  exitCode: number;
  stdout?: string;
  stderr: string;
}

function createValidationOptions(
  details?: string,
  optional?: boolean,
  exitCode?: number,
): {
  details?: string;
  exitCode?: number;
  optional?: boolean;
} {
  return {
    ...(details !== undefined ? { details } : {}),
    ...(optional !== undefined ? { optional } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function createValidationResult(
  base: Pick<ValidationResult, 'type' | 'target' | 'passed'>,
  options: {
    details?: string;
    exitCode?: number;
    optional?: boolean;
  } = {},
): ValidationResult {
  return {
    ...base,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.exitCode !== undefined ? { exit_code: options.exitCode } : {}),
    ...(options.optional !== undefined ? { optional: options.optional } : {}),
  };
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

function requireStringField(value: unknown, fieldName: string, validatorType: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Validator "${validatorType}" requires a non-empty "${fieldName}" string`);
  }
  return value;
}

function isPathWithinWorkingDirectory(resolvedPath: string, resolvedWorkingDirectory: string): boolean {
  if (resolvedPath === resolvedWorkingDirectory) {
    return true;
  }

  const normalizedWorkingDirectory = resolvedWorkingDirectory.endsWith(sep)
    ? resolvedWorkingDirectory
    : `${resolvedWorkingDirectory}${sep}`;

  return resolvedPath.startsWith(normalizedWorkingDirectory);
}

function getPathSecurityError(
  resolvedPath: string,
  resolvedWorkingDirectory: string,
  realWorkingDirectory: string,
  allowMissingRealPath = false,
): string | undefined {
  if (!isPathWithinWorkingDirectory(resolvedPath, resolvedWorkingDirectory)) {
    return 'Path traversal detected';
  }

  try {
    const realPath = realpathSync(resolvedPath);
    if (!isPathWithinWorkingDirectory(realPath, realWorkingDirectory)) {
      return 'Symlink traversal detected';
    }
  } catch (err) {
    const errorCode = typeof err === 'object' && err !== null && 'code' in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;

    if (!(allowMissingRealPath && errorCode === 'ENOENT')) {
      throw err;
    }
  }

  return undefined;
}

function getValidatorTarget(validator: ValidatorConfig): string {
  if (typeof validator.target === 'string') return validator.target;
  if (typeof validator.command === 'string') return validator.command;
  if (typeof validator.path === 'string') return validator.path;
  if (typeof validator.url === 'string') return validator.url;
  return 'unknown';
}

function getRunnerReasoningEffort(): string {
  const raw = process.env.LOCKSTEP_CODEX_REASONING_EFFORT?.trim().toLowerCase();
  return raw && VALID_REASONING_EFFORTS.has(raw)
    ? raw
    : DEFAULT_RUNNER_REASONING_EFFORT;
}

function buildCodexArgs(workingDirectory: string, runtimeConfig: RuntimeConfig): string[] {
  const args = [
    'exec',
    ...(runtimeConfig.executionMode === 'yolo'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--full-auto']),
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
  ];

  const model = runtimeConfig.runnerModel?.trim() || process.env.LOCKSTEP_CODEX_MODEL?.trim();
  if (model) {
    args.push('--model', model);
  }

  args.push(
    '-c',
    `model_reasoning_effort="${getRunnerReasoningEffort()}"`,
    '--cd', workingDirectory,
    '-',
  );

  return args;
}

function cleanEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.LOCKSTEP_API_KEY;
  return env;
}

function buildWorkspaceToolEnv(
  workingDirectory: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const toolRoot = resolve(workingDirectory, '.lockstep-tools');
  const xdgDataHome = resolve(toolRoot, 'xdg-data');
  const corepackHome = resolve(toolRoot, 'corepack');
  const pnpmHome = resolve(toolRoot, 'pnpm-home');
  const npmCache = resolve(toolRoot, 'npm-cache');
  const pnpmStoreDir = resolve(toolRoot, 'pnpm-store');

  for (const dir of [toolRoot, xdgDataHome, corepackHome, pnpmHome, npmCache, pnpmStoreDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const currentPath = baseEnv.PATH ?? '';
  const nextPath = currentPath.length > 0
    ? `${pnpmHome}${delimiter}${currentPath}`
    : pnpmHome;

  return {
    ...baseEnv,
    XDG_DATA_HOME: xdgDataHome,
    COREPACK_HOME: corepackHome,
    PNPM_HOME: pnpmHome,
    npm_config_cache: npmCache,
    pnpm_config_store_dir: pnpmStoreDir,
    PATH: nextPath,
  };
}

export function buildRunnerEnv(
  workingDirectory: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  runtimeConfig?: RuntimeConfig,
): NodeJS.ProcessEnv {
  let env = buildWorkspaceToolEnv(workingDirectory, cleanEnv(baseEnv));

  if (runtimeConfig?.runner === 'claude' || runtimeConfig?.judge === 'claude') {
    env = applyClaudeAuthMode(env, runtimeConfig.claudeAuthMode);
  }

  return {
    ...env,
    NO_COLOR: '1',
  };
}

export function buildRunnerPrompt(serverPrompt: string): string {
  return `${RUNNER_EXECUTION_RULES}\n\n${serverPrompt}`;
}

function buildClaudeRunnerSettings(runtimeConfig: RuntimeConfig): Record<string, unknown> {
  return {
    permissions: {
      ...(runtimeConfig.executionMode === 'standard'
        ? { allow: [...CLAUDE_ALLOWED_TOOL_RULES] }
        : {}),
    },
  };
}

function buildClaudeArgs(
  prompt: string,
  settingsPath: string,
  runtimeConfig: RuntimeConfig,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'text',
    '--setting-sources',
    'user,project,local',
    '--settings',
    settingsPath,
    '--tools',
    CLAUDE_RUNNER_TOOLS,
    '--permission-mode',
    runtimeConfig.executionMode === 'yolo' ? 'bypassPermissions' : 'dontAsk',
  ];

  const model = runtimeConfig.runnerModel?.trim();
  if (model) {
    args.push('--model', model);
  }

  args.push(prompt);
  return args;
}

async function runAgent(
  prompt: string,
  workingDirectory: string,
  verbose: boolean,
  runtimeConfig: RuntimeConfig,
  timeoutMs?: number,
): Promise<AgentResult> {
  const agent = createAgent(runtimeConfig.runner);
  const policy = loadPolicy(workingDirectory);
  const result = await agent.execute(prompt, {
    workingDirectory,
    timeout: timeoutMs ?? 300_000,
    ...(runtimeConfig.runnerModel ? { model: runtimeConfig.runnerModel } : {}),
    executionMode: runtimeConfig.executionMode,
    ...(runtimeConfig.runner === 'codex'
      ? { effortLevel: getRunnerReasoningEffort() }
      : {}),
    policy,
    env: buildRunnerEnv(workingDirectory, process.env, runtimeConfig),
    ...(verbose
      ? {
          onOutput: (text: string) => process.stdout.write(`\x1b[2m${text}\x1b[0m`),
          onStderr: (text: string) => process.stderr.write(`\x1b[2m${text}\x1b[0m`),
        }
      : {}),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runShellCommand(
  command: string,
  workingDirectory: string,
  runtimeConfigOrTimeout?: RuntimeConfig | number,
  timeoutMs?: number,
): Promise<ShellCommandResult> {
  const runtimeConfig = typeof runtimeConfigOrTimeout === 'number'
    ? undefined
    : runtimeConfigOrTimeout;
  const effectiveTimeoutMs = typeof runtimeConfigOrTimeout === 'number'
    ? runtimeConfigOrTimeout
    : timeoutMs;

  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: workingDirectory,
      env: buildRunnerEnv(workingDirectory, process.env, runtimeConfig),
      ...(effectiveTimeoutMs !== undefined ? { timeout: effectiveTimeoutMs } : {}),
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

function parseChangedFiles(statusOutput: string): string[] {
  const files = new Set<string>();

  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue;
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const normalized = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim() ?? rawPath
      : rawPath;
    if (normalized) {
      files.add(normalized);
    }
  }

  return [...files];
}

async function readWorkspaceMetadata(workingDirectory: string): Promise<WorkspaceMetadata> {
  const repoCheck = await runShellCommand('git rev-parse --is-inside-work-tree', workingDirectory, 15_000);
  if (repoCheck.exitCode !== 0) {
    return {};
  }

  const [branchResult, commitResult, changedFilesResult] = await Promise.all([
    runShellCommand('git rev-parse --abbrev-ref HEAD', workingDirectory, 15_000),
    runShellCommand('git rev-parse HEAD', workingDirectory, 15_000),
    runShellCommand('git status --porcelain=v1 --untracked-files=all', workingDirectory, 15_000),
  ]);

  const metadata: WorkspaceMetadata = {};

  const branch = branchResult.stdout?.trim();
  if (branch && branch !== 'HEAD') {
    metadata.workspaceBranch = branch;
  }

  const commit = commitResult.stdout?.trim();
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) {
    metadata.workspaceCommit = commit.toLowerCase();
  }

  const changedFiles = parseChangedFiles(changedFilesResult.stdout ?? '');
  if (changedFiles.length > 0) {
    metadata.changedFiles = changedFiles;
  }

  return metadata;
}

async function runValidator(
  validator: ValidatorConfig,
  workingDirectory: string,
  runtimeConfig: RuntimeConfig,
): Promise<ValidationResult> {
  const type = validator.type;
  const target = getValidatorTarget(validator);
  const optional = readOptionalBoolean(validator.optional);

  try {
    switch (type) {
      case 'file_exists': {
        const { existsSync } = await import('node:fs');
        const fileTarget = requireStringField(validator.target, 'target', type);
        const resolvedWorkingDirectory = resolve(workingDirectory);
        const realWorkingDirectory = realpathSync(resolvedWorkingDirectory);
        const resolvedPath = resolve(resolvedWorkingDirectory, fileTarget);
        const pathSecurityError = getPathSecurityError(
          resolvedPath,
          resolvedWorkingDirectory,
          realWorkingDirectory,
          true,
        );
        if (pathSecurityError) {
          return createValidationResult(
            { type, target: fileTarget, passed: false },
            createValidationOptions(pathSecurityError, optional),
          );
        }
        const exists = existsSync(resolvedPath);
        return createValidationResult(
          { type, target: fileTarget, passed: exists },
          createValidationOptions(exists ? undefined : 'File does not exist', optional),
        );
      }
      case 'file_not_exists': {
        const { existsSync } = await import('node:fs');
        const fileTarget = requireStringField(validator.target, 'target', type);
        const resolvedWorkingDirectory = resolve(workingDirectory);
        const realWorkingDirectory = realpathSync(resolvedWorkingDirectory);
        const resolvedPath = resolve(resolvedWorkingDirectory, fileTarget);
        const pathSecurityError = getPathSecurityError(
          resolvedPath,
          resolvedWorkingDirectory,
          realWorkingDirectory,
          true,
        );
        if (pathSecurityError) {
          return createValidationResult(
            { type, target: fileTarget, passed: false },
            createValidationOptions(pathSecurityError, optional),
          );
        }
        const exists = existsSync(resolvedPath);
        return createValidationResult(
          { type, target: fileTarget, passed: !exists },
          createValidationOptions(!exists ? undefined : 'File should not exist', optional),
        );
      }
      case 'file_contains': {
        const { readFileSync } = await import('node:fs');
        const filePath = requireStringField(validator.path, 'path', type);
        const pattern = requireStringField(validator.pattern, 'pattern', type);
        const isRegex = validator.is_regex === true;
        const resolvedWorkingDirectory = resolve(workingDirectory);
        const realWorkingDirectory = realpathSync(resolvedWorkingDirectory);
        const resolvedPath = resolve(resolvedWorkingDirectory, filePath);
        const pathSecurityError = getPathSecurityError(
          resolvedPath,
          resolvedWorkingDirectory,
          realWorkingDirectory,
        );
        if (pathSecurityError) {
          return createValidationResult(
            { type, target: filePath, passed: false },
            createValidationOptions(pathSecurityError, optional),
          );
        }
        const content = readFileSync(resolvedPath, 'utf-8');
        const matched = isRegex ? new RegExp(pattern).test(content) : content.includes(pattern);
        return createValidationResult(
          { type, target: filePath, passed: matched },
          createValidationOptions(matched ? undefined : `Pattern not found: ${pattern}`, optional),
        );
      }
      case 'file_not_contains': {
        const { readFileSync } = await import('node:fs');
        const filePath = requireStringField(validator.path, 'path', type);
        const pattern = requireStringField(validator.pattern, 'pattern', type);
        const isRegex = validator.is_regex === true;
        const resolvedWorkingDirectory = resolve(workingDirectory);
        const realWorkingDirectory = realpathSync(resolvedWorkingDirectory);
        const resolvedPath = resolve(resolvedWorkingDirectory, filePath);
        const pathSecurityError = getPathSecurityError(
          resolvedPath,
          resolvedWorkingDirectory,
          realWorkingDirectory,
        );
        if (pathSecurityError) {
          return createValidationResult(
            { type, target: filePath, passed: false },
            createValidationOptions(pathSecurityError, optional),
          );
        }
        const content = readFileSync(resolvedPath, 'utf-8');
        const matched = isRegex ? new RegExp(pattern, 'm').test(content) : content.includes(pattern);
        return createValidationResult(
          { type, target: filePath, passed: !matched },
          createValidationOptions(
            matched ? `Pattern unexpectedly found: ${pattern}` : undefined,
            optional,
          ),
        );
      }
      case 'json_valid': {
        const { readFileSync } = await import('node:fs');
        const filePath = requireStringField(validator.path, 'path', type);
        const resolvedWorkingDirectory = resolve(workingDirectory);
        const realWorkingDirectory = realpathSync(resolvedWorkingDirectory);
        const resolvedPath = resolve(resolvedWorkingDirectory, filePath);
        const pathSecurityError = getPathSecurityError(
          resolvedPath,
          resolvedWorkingDirectory,
          realWorkingDirectory,
        );
        if (pathSecurityError) {
          return createValidationResult(
            { type, target: filePath, passed: false },
            createValidationOptions(pathSecurityError, optional),
          );
        }

        try {
          JSON.parse(readFileSync(resolvedPath, 'utf-8'));
          return createValidationResult(
            { type, target: filePath, passed: true },
            createValidationOptions(undefined, optional),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return createValidationResult(
            { type, target: filePath, passed: false },
            createValidationOptions(`Invalid JSON: ${message}`, optional),
          );
        }
      }
      case 'ai_judge': {
        const criteria = requireStringField(validator.criteria, 'criteria', type);
        const threshold = readOptionalNumber(validator.threshold);
        if (threshold === undefined) {
          throw new Error('Validator "ai_judge" requires a numeric "threshold"');
        }

        const evaluationTargets = Array.isArray(validator.evaluation_targets)
          ? validator.evaluation_targets.filter((value): value is string => typeof value === 'string')
          : undefined;
        const result = await runAiJudge({
          criteria,
          threshold,
          evaluation_targets: evaluationTargets,
          rubric: validator.rubric === true,
          timeout: readOptionalNumber(validator.timeout),
          provider: runtimeConfig.judge,
          model: runtimeConfig.judgeModel,
          claudeAuthMode: runtimeConfig.claudeAuthMode,
        }, workingDirectory);

        return createValidationResult(
          { type, target, passed: result.passed },
          createValidationOptions(result.details, optional),
        );
      }
      case 'command_passes':
      case 'test_passes':
      case 'lint_passes':
      case 'type_check': {
        const command = typeof validator.command === 'string'
          ? validator.command
          : type === 'type_check'
            ? 'npx tsc --noEmit'
            : 'npx eslint .';
        const timeoutMs = (readOptionalNumber(validator.timeout) ?? 120) * 1000;
        const result = await runShellCommand(command, workingDirectory, runtimeConfig, timeoutMs);
        return createValidationResult(
          { type, target: command, passed: result.exitCode === 0 },
          createValidationOptions(
            result.exitCode === 0 ? undefined : result.stderr.slice(0, 500),
            optional,
            result.exitCode,
          ),
        );
      }
      default:
        return createValidationResult(
          { type, target, passed: false },
          createValidationOptions(`Validator type '${type}' is not supported by the remote runner bridge`, optional),
        );
    }
  } catch (err) {
    return createValidationResult(
      { type, target, passed: false },
      createValidationOptions(`Validator error: ${err instanceof Error ? err.message : String(err)}`, optional),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handlePromptReady(
  client: LockstepApiClient,
  runId: string,
  next: Extract<NextResponse, { status: 'prompt_ready' }>,
  localSpec: LocalSpec,
  workingDirectory: string,
  verbose: boolean,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  const stepNumber = next.stepIndex + 1;
  const localStep = localSpec.steps[next.stepIndex];
  if (!localStep) {
    throw new Error(`Server requested step ${next.stepIndex} but local spec only has ${localSpec.steps.length} steps`);
  }

  console.log(`\x1b[1m● Step ${stepNumber}: ${next.stepName}\x1b[0m (attempt ${next.attempt}/${next.maxRetries})`);

  // Use pre_commands from LOCAL spec only (never trust server-supplied commands)
  for (const command of localStep.pre_commands ?? []) {
    console.log(`  pre: ${command}`);
    await runShellCommand(command, workingDirectory, runtimeConfig);
  }

  // Verify server prompt contains the local spec's prompt (integrity check)
  if (!next.prompt.includes(localStep.prompt)) {
    console.error(`  \x1b[31m⚠ Server prompt does not match local spec for step "${localStep.name}". Rejecting.\x1b[0m`);
    throw new Error('Server returned a prompt that does not match the local spec. Possible tampering.');
  }

  console.log('  ▸ Running AI agent...');
  const agentTimeoutMs = ((next.stepTimeoutSeconds ?? 300) * 1000);
  const agentResult = await runAgent(
    buildRunnerPrompt(next.prompt),
    workingDirectory,
    verbose,
    runtimeConfig,
    agentTimeoutMs,
  );

  // Use validators from LOCAL spec (cross-reference with server)
  console.log('  ▸ Validating...');
  const validationResults: ValidationResult[] = [];

  for (const validator of localStep.validate) {
    if (verbose && validator.type === 'ai_judge') {
      const evaluationTargets = Array.isArray(validator.evaluation_targets)
        ? validator.evaluation_targets.filter((value): value is string => typeof value === 'string')
        : [];
      const perRunTimeoutSeconds = readOptionalNumber(validator.timeout) ?? 120;
      console.log(
        `    ▸ ai_judge: reviewing ${evaluationTargets.length} files with ${3} parallel judge runs (timeout ${perRunTimeoutSeconds}s each)`,
      );
    }

    const result = await runValidator(validator, workingDirectory, runtimeConfig);
    validationResults.push(result);
    const icon = result.passed
      ? '\x1b[32m✓\x1b[0m'
      : result.optional
        ? '\x1b[33m○\x1b[0m'
        : '\x1b[31m✗\x1b[0m';
    console.log(`    ${icon} ${result.type}: ${result.target}${result.details ? ` - ${result.details}` : ''}`);
  }

  // Use post_commands from LOCAL spec only
  const allPassed = validationResults.every((result) => result.passed || result.optional === true);
  if (allPassed) {
    for (const command of localStep.post_commands ?? []) {
      console.log(`  post: ${command}`);
      await runShellCommand(command, workingDirectory, runtimeConfig);
    }
  }

  if (verbose) {
    console.log('  ▸ Collecting workspace metadata...');
  }
  const workspaceMetadata = await readWorkspaceMetadata(workingDirectory);
  if (verbose) {
    console.log(`  ▸ Workspace metadata: ${JSON.stringify(workspaceMetadata)}`);
    console.log('  ▸ Submitting results to API...');
  }

  const submitResult = await client.submitResult(
    runId,
    next.stepIndex,
    next.attempt,
    validationResults,
    sha256(agentResult.stdout),
    sha256(agentResult.stderr),
    workspaceMetadata,
  );
  if (verbose) {
    console.log(`  ▸ API submission status: ${submitResult.status}`);
  }

  console.log('');
}

export function parseLocalSpec(specYaml: string): LocalSpec {
  if (specYaml.length > 500_000) {
    throw new Error('Spec too large');
  }

  const loadOptions = { maxAliases: 100 } as yaml.LoadOptions;
  const parsed = yaml.load(specYaml, loadOptions) as Record<string, unknown>;
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('Invalid spec: missing steps array');
  }
  return parsed as unknown as LocalSpec;
}

export async function executeRun(
  client: LockstepApiClient,
  specYaml: string,
  workingDirectory: string,
  verbose: boolean,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  const localSpec = parseLocalSpec(specYaml);
  console.log(
    `\x1b[1m▶ Starting Lockstep run...\x1b[0m runner=${runtimeConfig.runner} judge=${runtimeConfig.judge}`,
  );
  const { runId } = await client.startRun(specYaml);
  console.log(`  Run ID: ${runId}\n`);

  while (true) {
    const next = await client.getNext(runId);

    switch (next.status) {
      case 'completed':
        console.log('\x1b[32m\x1b[1m✓ Run completed successfully\x1b[0m');
        if (next.receipt) {
          console.log(`  Steps: ${next.receipt.steps_passed}/${next.receipt.total_steps} passed`);
          console.log(`  Chain hash: ${next.receipt.chain_hash}`);
        }
        return;
      case 'failed':
        console.error('\x1b[31m\x1b[1m✗ Run failed\x1b[0m');
        return;
      case 'processing':
        if (verbose) {
          console.log(`  ▸ API processing step ${next.currentStep + 1}/${next.totalSteps}; retrying in ${next.retryAfter}s`);
        }
        await sleep(next.retryAfter * 1000);
        break;
      case 'prompt_ready':
        await handlePromptReady(client, runId, next, localSpec, workingDirectory, verbose, runtimeConfig);
        break;
    }
  }
}
