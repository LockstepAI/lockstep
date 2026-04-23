import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getJudgeReasoningEffort } from '../utils/env.js';
import {
  applyClaudeAuthMode,
  type ClaudeAuthMode,
  type ProviderName,
} from '../utils/providers.js';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

export interface StructuredProviderRequest {
  provider?: ProviderName;
  prompt: string;
  schema: Record<string, unknown>;
  workingDirectory: string;
  timeoutMs: number;
  model?: string;
  claudeAuthMode?: ClaudeAuthMode;
}

function writeSchemaFile(schema: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lockstep-provider-schema-'));
  const schemaPath = path.join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
  return schemaPath;
}

function unwrapStructuredOutput(output: string): unknown {
  const parsed = JSON.parse(output) as unknown;
  if (
    typeof parsed === 'object'
    && parsed !== null
    && 'structured_output' in parsed
  ) {
    return (parsed as { structured_output?: unknown }).structured_output;
  }

  return parsed;
}

function runCodexStructuredPrompt(
  request: StructuredProviderRequest,
): unknown {
  const schemaPath = writeSchemaFile(request.schema);

  try {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '--cd', request.workingDirectory,
      '-c', `model_reasoning_effort="${getJudgeReasoningEffort()}"`,
      '--output-schema', schemaPath,
    ];

    const resolvedModel = request.model?.trim();
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    args.push('-');

    const output = childProcess.execFileSync(CODEX_BIN, args, {
      cwd: request.workingDirectory,
      input: request.prompt,
      encoding: 'utf-8',
      timeout: request.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    }).trim();

    return JSON.parse(output) as unknown;
  } finally {
    rmSync(path.dirname(schemaPath), { recursive: true, force: true });
  }
}

function runClaudeStructuredPrompt(
  request: StructuredProviderRequest,
): unknown {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--tools',
    '',
    '--permission-mode',
    'plan',
  ];

  const resolvedModel = request.model?.trim();
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }

  args.push(request.prompt);

  const result = childProcess.spawnSync(CLAUDE_BIN, args, {
    cwd: request.workingDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: request.timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...applyClaudeAuthMode(process.env, request.claudeAuthMode ?? 'auto'),
      NO_COLOR: '1',
    },
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`Claude request timed out after ${request.timeoutMs}ms`);
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim()
      || result.stdout.trim()
      || `Claude exited with code ${result.status ?? 1}`,
    );
  }

  const text = result.stdout.trim();
  if (!text) {
    throw new Error('Claude returned empty output');
  }

  return unwrapStructuredOutput(text);
}

export function runStructuredProviderPrompt(
  request: StructuredProviderRequest,
): unknown {
  if (request.provider === 'claude') {
    return runClaudeStructuredPrompt(request);
  }

  return runCodexStructuredPrompt(request);
}
