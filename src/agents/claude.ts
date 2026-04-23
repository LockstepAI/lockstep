import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { delimiter, resolve } from 'node:path';
import type { Agent, AgentOptions, AgentResult } from './base.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CLAUDE_TOOL_TIMEOUT_SECONDS = 30;
const CLAUDE_ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,LSP,TodoWrite';
const CLAUDE_ALLOWED_TOOL_RULES = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'TodoWrite'];

function buildClaudeHookCommand(
  hookScriptPath: string,
  policyPath: string,
  workingDirectory: string,
): string {
  const quote = (value: string): string => JSON.stringify(value);
  return `${quote(process.execPath)} ${quote(hookScriptPath)} ${quote(policyPath)} ${quote(workingDirectory)}`;
}

function buildClaudeSettings(
  hookScriptPath: string,
  policyPath: string,
  workingDirectory: string,
  options: AgentOptions,
): Record<string, unknown> {
  const hookCommand = buildClaudeHookCommand(hookScriptPath, policyPath, workingDirectory);

  return {
    permissions: {
      ...(options.executionMode === 'yolo' ? {} : { allow: CLAUDE_ALLOWED_TOOL_RULES }),
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              timeout: CLAUDE_TOOL_TIMEOUT_SECONDS,
            },
          ],
        },
        {
          matcher: 'Edit',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              timeout: CLAUDE_TOOL_TIMEOUT_SECONDS,
            },
          ],
        },
        {
          matcher: 'Write',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              timeout: CLAUDE_TOOL_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

function buildClaudeHookSource(): string {
  const policyEngineModuleUrl = new URL('../policy/engine.js', import.meta.url).href;

  return `import { readFileSync } from 'node:fs';
import { PolicyEngine } from ${JSON.stringify(policyEngineModuleUrl)};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function allow() {
  respond({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
}

function deny(reason) {
  respond({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function candidatePaths(toolInput) {
  const paths = [];
  for (const key of ['file_path', 'path', 'target_file']) {
    if (typeof toolInput[key] === 'string') {
      paths.push(toolInput[key]);
    }
  }
  return paths;
}

async function main() {
  const [, , policyPath, workingDirectory] = process.argv;
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const engine = new PolicyEngine(policy, workingDirectory);
  const rawInput = await readStdin();
  const input = rawInput.trim() ? JSON.parse(rawInput) : {};
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) {
      deny('Blocked Bash execution because no command was provided.');
      return;
    }

    const decision = engine.evaluateShellCommand(command);
    if (!decision.allowed) {
      deny(decision.reason ?? 'Blocked by Lockstep policy.');
      return;
    }

    allow();
    return;
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const paths = candidatePaths(toolInput);
    if (paths.length === 0) {
      deny(\`Blocked \${toolName} because no writable path was provided.\`);
      return;
    }

    for (const filePath of paths) {
      const decision = engine.evaluateFileWrite(filePath);
      if (!decision.allowed) {
        deny(decision.reason ?? \`Blocked write to \${filePath}.\`);
        return;
      }
    }

    allow();
    return;
  }

  allow();
}

main().catch((error) => {
  deny(error instanceof Error ? error.message : String(error));
});
`;
}

function buildClaudeArgs(
  prompt: string,
  settingsPath: string,
  options: AgentOptions,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'text',
    '--effort',
    options.effortLevel ?? 'medium',
    '--setting-sources',
    'user,project,local',
    '--settings',
    settingsPath,
    '--tools',
    CLAUDE_ALLOWED_TOOLS,
    '--permission-mode',
    options.executionMode === 'yolo' ? 'bypassPermissions' : 'dontAsk',
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  args.push(prompt);
  return args;
}

function buildClaudeEnv(workingDirectory: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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
    NO_COLOR: '1',
    XDG_DATA_HOME: xdgDataHome,
    COREPACK_HOME: corepackHome,
    PNPM_HOME: pnpmHome,
    npm_config_cache: npmCache,
    pnpm_config_store_dir: pnpmStoreDir,
    PATH: nextPath,
  };
}

export class ClaudeAgent implements Agent {
  name = 'claude';

  async execute(prompt: string, options: AgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'lockstep-claude-agent-'));
    const policyPath = path.join(tempDir, 'policy.json');
    const hookPath = path.join(tempDir, 'lockstep-policy-hook.mjs');
    const settingsPath = path.join(tempDir, 'settings.json');

    writeFileSync(policyPath, JSON.stringify(options.policy ?? {}, null, 2), 'utf-8');
    writeFileSync(hookPath, buildClaudeHookSource(), 'utf-8');
    writeFileSync(
      settingsPath,
      JSON.stringify(buildClaudeSettings(hookPath, policyPath, options.workingDirectory, options), null, 2),
      'utf-8',
    );

    return new Promise((resolve) => {
      const proc = spawn(CLAUDE_BIN, buildClaudeArgs(prompt, settingsPath, options), {
        cwd: options.workingDirectory,
        timeout: options.timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeEnv(options.workingDirectory, options.env),
      });

      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];

      const append = (
        sink: ((line: string) => void) | undefined,
        parts: string[],
        chunk: string,
      ): void => {
        parts.push(chunk);
        sink?.(chunk);
      };

      proc.stdout.on('data', (data: Buffer) => {
        append(options.onOutput, stdoutParts, data.toString());
      });

      proc.stderr.on('data', (data: Buffer) => {
        append(options.onStderr, stderrParts, data.toString());
      });

      const finalize = (result: AgentResult): void => {
        rmSync(tempDir, { recursive: true, force: true });
        resolve(result);
      };

      proc.on('close', (code, signal) => {
        const stdout = stdoutParts.join('');
        const stderr = stderrParts.join('');
        const isTimeout = signal === 'SIGTERM' || signal === 'SIGKILL';

        finalize({
          success: code === 0,
          stdout,
          stderr: isTimeout ? `Claude timed out after ${options.timeout}ms\n${stderr}`.trim() : stderr,
          combinedOutput: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''),
          exitCode: code ?? 1,
          duration: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        finalize({
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
