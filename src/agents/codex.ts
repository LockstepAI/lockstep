import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentResult, AgentOptions } from './base.js';
import { PolicyEngine } from '../policy/engine.js';
import type { PolicyDecision } from '../policy/types.js';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CODEX_HOOK_SCRIPT = resolve(MODULE_DIR, '../policy/codex-hook.js');
const CODEX_RUNTIME_PREFIX = 'lockstep-codex-runtime-';
const LOCKSTEP_RUNTIME_ROOT = join(homedir(), '.lockstep', 'codex-runtime');

type CodexJsonEvent = {
  type?: string;
  item?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getReasoningEffort(effortLevel?: string): string {
  switch (effortLevel) {
    case 'low':
    case 'medium':
    case 'high':
      return effortLevel;
    case 'max':
      return 'xhigh';
    default:
      return 'medium';
  }
}

function buildCodexArgs(options: AgentOptions): string[] {
  const args = [
    'exec',
    '--enable',
    'codex_hooks',
    ...(options.executionMode === 'yolo'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"']),
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  args.push(
    '-c',
    `model_reasoning_effort="${getReasoningEffort(options.effortLevel)}"`,
    '--cd',
    options.workingDirectory,
    '-',
  );

  return args;
}

function appendChunk(
  sink: (chunk: string) => void | undefined,
  parts: string[],
  chunk: string,
): void {
  parts.push(chunk);
  sink(chunk);
}

function formatPolicyDecision(decision: PolicyDecision): string {
  const segments = [
    `Policy blocked ${decision.tool} action`,
    decision.reason ?? 'Blocked by policy.',
  ];

  if (decision.rule) {
    segments.push(`Rule: ${decision.rule}`);
  }

  if (decision.approval_id) {
    segments.push(`Approve with: lockstep approve ${decision.approval_id}`);
  }

  return `${segments.join('\n')}\n`;
}

function formatCommandOutput(command: string, output: string): string {
  const trimmed = output.trimEnd();
  if (!trimmed) {
    return `$ ${command}\n`;
  }

  return `$ ${command}\n${trimmed}\n`;
}

function formatFileChange(kind: string, filePath: string): string {
  return `[file_change] ${kind} ${filePath}\n`;
}

function maybeEvaluatePolicy(
  item: Record<string, unknown>,
  policyEngine: PolicyEngine,
): PolicyDecision | null {
  const itemType = typeof item.type === 'string' ? item.type : '';

  if (itemType === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    return command ? policyEngine.evaluateShellCommand(command) : null;
  }

  if (itemType === 'file_change' && Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (!isRecord(change) || typeof change.path !== 'string') {
        continue;
      }

      const decision = policyEngine.evaluateFileWrite(change.path);
      if (!decision.allowed) {
        return decision;
      }
    }
  }

  if (itemType === 'file_read') {
    const filePath = typeof item.path === 'string'
      ? item.path
      : typeof item.file_path === 'string'
        ? item.file_path
        : '';
    return filePath ? policyEngine.evaluateFileRead(filePath) : null;
  }

  return null;
}

function handleCompletedItem(
  item: Record<string, unknown>,
  emitStdout: (chunk: string) => void,
): void {
  const itemType = typeof item.type === 'string' ? item.type : '';

  if (itemType === 'agent_message' && typeof item.text === 'string') {
    emitStdout(`${item.text}\n`);
    return;
  }

  if (itemType === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const aggregatedOutput = typeof item.aggregated_output === 'string'
      ? item.aggregated_output
      : '';

    if (command) {
      emitStdout(formatCommandOutput(command, aggregatedOutput));
    }
    return;
  }

  if (itemType === 'file_change' && Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (!isRecord(change)) {
        continue;
      }

      const kind = typeof change.kind === 'string' ? change.kind : 'update';
      const filePath = typeof change.path === 'string' ? change.path : 'unknown';
      emitStdout(formatFileChange(kind, filePath));
    }
  }
}

function parseJsonLine(line: string): CodexJsonEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed as CodexJsonEvent : null;
  } catch {
    return null;
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function sourceCodexHome(baseEnv: NodeJS.ProcessEnv): string {
  return resolve(baseEnv.CODEX_HOME ?? join(homedir(), '.codex'));
}

function copyIfExists(sourcePath: string, targetPath: string): void {
  if (existsSync(sourcePath)) {
    copyFileSync(sourcePath, targetPath);
  }
}

function ensureConfigFeatureFlags(config: string): string {
  const required = new Map([
    ['codex_hooks', 'true'],
    ['use_linux_sandbox_bwrap', 'true'],
  ]);
  const pending = new Set(required.keys());
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inFeatures = false;
  let sawFeatures = false;

  const flushPending = (): void => {
    for (const key of pending) {
      output.push(`${key} = ${required.get(key)}`);
    }
    pending.clear();
  };

  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/)?.[1];
    if (section && inFeatures) {
      flushPending();
    }

    if (section) {
      inFeatures = section === 'features';
      sawFeatures = sawFeatures || inFeatures;
    }

    if (inFeatures) {
      const key = line.trim().match(/^([A-Za-z0-9_-]+)\s*=/)?.[1];
      if (key && required.has(key)) {
        output.push(`${key} = ${required.get(key)}`);
        pending.delete(key);
        continue;
      }
    }

    output.push(line);
  }

  if (sawFeatures) {
    flushPending();
  } else {
    if (output.length > 0 && output.at(-1) !== '') {
      output.push('');
    }
    output.push('[features]');
    for (const [key, value] of required) {
      output.push(`${key} = ${value}`);
    }
  }

  return output.join('\n').replace(/\n*$/, '\n');
}

function ensureTrustedProject(config: string, workingDirectory: string): string {
  const header = `[projects.${quoteTomlString(workingDirectory)}]`;
  if (config.includes(header)) {
    return config;
  }

  const separator = config.endsWith('\n') ? '' : '\n';
  return [
    `${config}${separator}`,
    header,
    'trust_level = "trusted"',
    '',
  ].join('\n');
}

function writeCodexRuntimeConfig(
  workingDirectory: string,
  runtimeCodexHome: string,
  baseEnv: NodeJS.ProcessEnv,
): void {
  const sourceHome = sourceCodexHome(baseEnv);
  copyIfExists(join(sourceHome, 'auth.json'), join(runtimeCodexHome, 'auth.json'));
  copyIfExists(join(sourceHome, 'installation_id'), join(runtimeCodexHome, 'installation_id'));
  copyIfExists(join(sourceHome, 'models_cache.json'), join(runtimeCodexHome, 'models_cache.json'));

  const sourceConfigPath = join(sourceHome, 'config.toml');
  const sourceConfig = existsSync(sourceConfigPath)
    ? readFileSync(sourceConfigPath, 'utf-8')
    : '';
  const configWithFeatures = ensureConfigFeatureFlags(sourceConfig);
  writeFileSync(
    join(runtimeCodexHome, 'config.toml'),
    ensureTrustedProject(configWithFeatures, workingDirectory),
    'utf-8',
  );
}

function writeCodexHookConfig(
  runtimeCodexHome: string,
): void {
  const hookCommand = `${quoteShellArg(process.execPath)} ${quoteShellArg(CODEX_HOOK_SCRIPT)}`;
  const hooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              timeout: 10,
              statusMessage: 'Lockstep policy check',
            },
          ],
        },
      ],
    },
  };

  writeFileSync(
    join(runtimeCodexHome, 'hooks.json'),
    `${JSON.stringify(hooks, null, 2)}\n`,
    'utf-8',
  );
}

function buildCodexRuntimeEnv(
  workingDirectory: string,
  policy: AgentOptions['policy'],
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  mkdirSync(LOCKSTEP_RUNTIME_ROOT, { recursive: true });
  const runtimeRoot = mkdtempSync(join(LOCKSTEP_RUNTIME_ROOT, CODEX_RUNTIME_PREFIX));
  const runtimeCodexHome = join(runtimeRoot, 'home');
  const runtimePolicyPath = join(runtimeRoot, 'policy.json');

  mkdirSync(runtimeCodexHome, { recursive: true });
  writeCodexRuntimeConfig(workingDirectory, runtimeCodexHome, baseEnv);
  writeCodexHookConfig(runtimeCodexHome);
  writeFileSync(runtimePolicyPath, `${JSON.stringify(policy ?? {}, null, 2)}\n`, 'utf-8');

  return {
    CODEX_HOME: runtimeCodexHome,
    LOCKSTEP_CODEX_RUNTIME_DIR: runtimeRoot,
    LOCKSTEP_CODEX_POLICY_PATH: runtimePolicyPath,
    LOCKSTEP_CODEX_WORKING_DIR: workingDirectory,
  };
}

function cleanupCodexRuntime(env: NodeJS.ProcessEnv): void {
  const runtimeRoot = env.LOCKSTEP_CODEX_RUNTIME_DIR;
  if (!runtimeRoot || !runtimeRoot.startsWith(join(LOCKSTEP_RUNTIME_ROOT, CODEX_RUNTIME_PREFIX))) {
    return;
  }

  rmSync(runtimeRoot, { recursive: true, force: true });
}

function buildCodexEnv(
  workingDirectory: string,
  policy: AgentOptions['policy'],
  baseEnv: NodeJS.ProcessEnv = process.env,
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
    ...buildCodexRuntimeEnv(workingDirectory, policy, baseEnv),
    NO_COLOR: '1',
    XDG_DATA_HOME: xdgDataHome,
    COREPACK_HOME: corepackHome,
    PNPM_HOME: pnpmHome,
    npm_config_cache: npmCache,
    pnpm_config_store_dir: pnpmStoreDir,
    PATH: nextPath,
  };
}

export class CodexAgent implements Agent {
  name = 'codex';

  async execute(prompt: string, options: AgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const args = buildCodexArgs(options);
    const policyEngine = new PolicyEngine(options.policy ?? {}, options.workingDirectory);
    const codexEnv = buildCodexEnv(options.workingDirectory, options.policy, options.env);

    return new Promise((resolve) => {
      const proc = spawn(CODEX_BIN, args, {
        cwd: options.workingDirectory,
        timeout: options.timeout,
        env: codexEnv,
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let stdoutBuffer = '';
      let blockedDecision: PolicyDecision | null = null;

      const emitStdout = (chunk: string): void => {
        appendChunk((text) => options.onOutput?.(text), stdoutParts, chunk);
      };

      const emitStderr = (chunk: string): void => {
        appendChunk((text) => options.onStderr?.(text), stderrParts, chunk);
      };

      const blockAgent = (decision: PolicyDecision): void => {
        if (blockedDecision) {
          return;
        }

        blockedDecision = decision;
        emitStderr(formatPolicyDecision(decision));
        if (!proc.killed) {
          proc.kill('SIGTERM');
        }
      };

      const processStdoutBuffer = (): void => {
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const event = parseJsonLine(trimmed);
          if (!event) {
            emitStdout(`${line}\n`);
            continue;
          }

          if (event.type === 'item.started' && isRecord(event.item)) {
            const decision = maybeEvaluatePolicy(event.item, policyEngine);
            if (decision && !decision.allowed) {
              blockAgent(decision);
              continue;
            }
          }

          if (event.type === 'item.completed' && isRecord(event.item)) {
            handleCompletedItem(event.item, emitStdout);
          }
        }
      };

      proc.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        processStdoutBuffer();
      });

      proc.stderr.on('data', (data: Buffer) => {
        emitStderr(data.toString());
      });

      proc.on('close', (code, signal) => {
        cleanupCodexRuntime(codexEnv);

        if (stdoutBuffer.trim().length > 0) {
          emitStdout(`${stdoutBuffer.trimEnd()}\n`);
        }

        const stdout = stdoutParts.join('');
        const stderr = stderrParts.join('');

        if (blockedDecision) {
          resolve({
            success: false,
            stdout,
            stderr,
            combinedOutput: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''),
            exitCode: code ?? 1,
            duration: Date.now() - startTime,
          });
          return;
        }

        const isTimeout = signal === 'SIGTERM' || signal === 'SIGKILL';
        resolve({
          success: code === 0,
          stdout,
          stderr: isTimeout ? `Agent timed out after ${options.timeout}ms\n${stderr}` : stderr,
          combinedOutput: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''),
          exitCode: code ?? 1,
          duration: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        cleanupCodexRuntime(codexEnv);

        resolve({
          success: false,
          stdout: '',
          stderr: `Process error: ${err.message}`,
          combinedOutput: `Process error: ${err.message}`,
          exitCode: 1,
          duration: Date.now() - startTime,
        });
      });
    });
  }
}
