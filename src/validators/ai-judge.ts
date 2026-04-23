import {
  readFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { sha256 } from '../utils/crypto.js';
import { JudgeInfraError } from '../utils/errors.js';
import { getJudgeRubric } from '../parallel/production-rules.js';
import { resolveWithinRoot, toRepoRelativePath } from '../utils/path-security.js';
import { getJudgeModel, getJudgeReasoningEffort } from '../utils/env.js';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';

export interface JudgeConfig {
  mode: 'codex' | 'claude';
  model?: string;
  effortLevel?: string;
}

interface ParsedJudgeResponse {
  scores: number[];
  reasoning: string;
  raw: Record<string, unknown>;
}

interface JudgeRunResult {
  scores: number[];
  averageScore: number;
  aggregateScore: number;
  autoFail: boolean;
  violations: string[];
  rawOutput: string;
}

interface SuccessfulJudgeRun {
  run: number;
  result: JudgeRunResult;
}

interface JudgeRunFailure {
  run: number;
  error: string;
}

const DEFAULT_AI_JUDGE_TIMEOUT_MS = 120_000;
const CODEX_JUDGE_BIN = process.env.CODEX_BIN ?? 'codex';
const CLAUDE_JUDGE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const JUDGE_DIFF_CONTEXT_LINES = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildJudgePrompt(criteria: string, fileContents: string, useRubric: boolean): string {
  if (useRubric) {
    return [
      'You are a senior production engineer reviewing AI-generated code.',
      'You are adversarial — you are looking for problems, not confirming quality.',
      'Assume the code WILL fail in production and find out where.',
      'Judge the proposed change, not the whole repository.',
      'Treat unchanged legacy code as context only.',
      'If a section is marked as a git diff, review the patch and its local context.',
      'Do not penalize unrelated pre-existing patterns outside the changed area.',
      'Do NOT run commands, inspect the repository, or request more context.',
      'Use ONLY the change package below and return JSON immediately.',
      '',
      getJudgeRubric(),
      '',
      'Additional criteria from the spec:',
      criteria,
      '',
      '## Content to Evaluate',
      '```',
      fileContents,
      '```',
      '',
      '## Instructions',
      'Score each of the 15 rubric items (0-2). If any Critical item scores 0, set auto_fail to true.',
      'Respond with ONLY a valid JSON object:',
      '{"scores": [<15 numbers 0-2>], "total": <sum>, "grade": <total/30*10>, "auto_fail": <bool>, "violations": ["description of each violation"], "reasoning": "<brief explanation>"}',
      '',
      'Do not include any text outside the JSON object.',
      'Do not wrap the JSON in markdown code fences.',
    ].join('\n');
  }

  return [
    'You are an expert code reviewer acting as an automated judge.',
    'Evaluate the proposed change against the given criteria.',
    'Judge only the changed implementation and its local context.',
    'Treat unchanged legacy code as context, not as part of the score.',
    'Do NOT run commands, inspect the repository, or request more context.',
    'Use ONLY the change package below and return JSON immediately.',
    '',
    '## Criteria',
    criteria,
    '',
    '## Change Package to Evaluate',
    '```',
    fileContents,
    '```',
    '',
    '## Instructions',
    'Score the content on a scale of 0 to 10 for each criterion.',
    'Use 10 only when the change clearly satisfies the criteria with minimal blast radius.',
    'Use 0 only when the change clearly fails the criteria or introduces a serious issue.',
    'Respond with ONLY a valid JSON object in this exact format:',
    '{"scores": [<number>, ...], "reasoning": "<brief explanation>"}',
    '',
    'Each score must be a number between 0 and 10.',
    'Do not include any text outside the JSON object.',
    'Do not wrap the JSON in markdown code fences.',
  ].join('\n');
}

function readTargetGitDiff(
  target: string,
  workingDirectory: string,
): string | null {
  let repoRelativeTarget: string;
  try {
    repoRelativeTarget = toRepoRelativePath(workingDirectory, target);
  } catch {
    return null;
  }

  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-ext-diff',
      `--unified=${JUDGE_DIFF_CONTEXT_LINES}`,
      '--',
      repoRelativeTarget,
    ],
    {
      cwd: workingDirectory,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    },
  );

  if (result.status !== 0) {
    return null;
  }

  const diff = result.stdout.trim();
  return diff.length > 0 ? diff : null;
}

function buildEvaluationPayload(
  targets: string[],
  workingDirectory: string,
): string {
  const parts: string[] = [];

  for (const target of targets) {
    const repoRelativeTarget = (() => {
      try {
        return toRepoRelativePath(workingDirectory, target);
      } catch {
        return target;
      }
    })();

    const diff = readTargetGitDiff(target, workingDirectory);
    if (diff) {
      parts.push(`--- ${repoRelativeTarget} (git diff) ---\n${diff}`);
      continue;
    }

    try {
      const resolvedPath = resolveWithinRoot(workingDirectory, target);
      const content = readFileSync(resolvedPath, 'utf-8');
      parts.push(`--- ${repoRelativeTarget} (current file) ---\n${content}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parts.push(`--- ${repoRelativeTarget} ---\n[ERROR: Could not read file: ${message}]`);
    }
  }

  return parts.join('\n\n');
}

function hasScorePayload(value: unknown): value is unknown[] | Record<string, unknown> {
  return (
    Array.isArray(value) ||
    (typeof value === 'object' && value !== null && !Array.isArray(value))
  );
}

function normalizeScores(scores: unknown): number[] {
  if (Array.isArray(scores)) {
    if (scores.length === 0) {
      throw new Error('Judge output missing "scores" array or array is empty');
    }

    return scores.map((score) => {
      const value = Number(score);
      if (Number.isNaN(value) || value < 0 || value > 10) {
        throw new Error(`Invalid score value: ${score}`);
      }
      return value;
    });
  }

  if (typeof scores === 'object' && scores !== null) {
    const entries = Object.entries(scores);
    if (entries.length === 0) {
      throw new Error('Judge output missing "scores" object entries');
    }

    const sortedEntries = entries.sort(([left], [right]) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      const leftNumeric = Number.isFinite(leftNumber);
      const rightNumeric = Number.isFinite(rightNumber);

      if (leftNumeric && rightNumeric) {
        return leftNumber - rightNumber;
      }

      return left.localeCompare(right);
    });

    return sortedEntries.map(([, score]) => {
      const value = Number(score);
      if (Number.isNaN(value) || value < 0 || value > 10) {
        throw new Error(`Invalid score value: ${score}`);
      }
      return value;
    });
  }

  throw new Error('Judge output missing "scores" array/object');
}

/**
 * Extract a JSON object containing "scores" from a string, using
 * brace-depth counting that respects quoted strings. This avoids the
 * problem where a `}` inside a "reasoning" value would prematurely
 * truncate a naive regex match.
 */
function extractJsonWithScores(text: string): string | null {
  const marker = '"scores"';
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIdx = text.indexOf(marker, searchFrom);
    if (markerIdx === -1) return null;

    // Walk backwards to find the opening brace
    let start = -1;
    for (let i = markerIdx - 1; i >= 0; i--) {
      if (text[i] === '{') { start = i; break; }
    }
    if (start === -1) { searchFrom = markerIdx + 1; continue; }

    // Walk forwards counting braces, respecting quoted strings
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.substring(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (hasScorePayload(parsed.scores)) return candidate;
          } catch { /* invalid JSON at this span, keep searching */ }
          break;
        }
      }
    }

    searchFrom = markerIdx + 1;
  }

  return null;
}

function parseJudgeResponse(raw: string): ParsedJudgeResponse {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');

  // Try parsing the entire response as JSON first
  try {
    const direct = JSON.parse(cleaned.trim()) as { scores?: unknown; reasoning?: unknown };
    if (hasScorePayload(direct.scores)) {
      return validateScores(direct);
    }
  } catch { /* not pure JSON, try extraction */ }

  // Extract JSON object from mixed text using brace counting
  const jsonStr = extractJsonWithScores(cleaned);
  if (!jsonStr) {
    throw new Error(`No valid JSON with "scores" found in judge output: ${raw.substring(0, 500)}`);
  }

  const parsed = JSON.parse(jsonStr) as { scores?: unknown; reasoning?: unknown };
  return validateScores(parsed);
}

function validateScores(
  parsed: { scores?: unknown; reasoning?: unknown } & Record<string, unknown>,
): ParsedJudgeResponse {
  return {
    scores: normalizeScores(parsed.scores),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    raw: parsed,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function scoreSpread(values: number[]): number {
  if (values.length <= 1) return 0;
  return Math.max(...values) - Math.min(...values);
}

function getJudgeTimeoutMs(config: Record<string, unknown>): number {
  const timeoutSeconds = config.timeout as number | undefined;
  if (
    typeof timeoutSeconds === 'number' &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds > 0
  ) {
    return Math.trunc(timeoutSeconds * 1000);
  }

  return DEFAULT_AI_JUDGE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Codex mode: run `codex exec` in a read-only sandbox
// ---------------------------------------------------------------------------

function runCodexJudge(
  prompt: string,
  workingDirectory: string,
  model: string | undefined,
  reasoningEffort: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '--cd', workingDirectory,
      '-c', `model_reasoning_effort="${reasoningEffort}"`,
    ];

    if (model) {
      args.push('--model', model);
    }

    args.push('-');

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    timeoutHandle.unref();
    let settled = false;
    let timedOut = false;

    const settle = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      handler();
    };

    controller.signal.addEventListener('abort', () => {
      timedOut = true;
    });

    const child = spawn(CODEX_JUDGE_BIN, args, {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      signal: controller.signal,
    });

    // Send prompt via stdin to avoid ARG_MAX limits and shell escaping
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(() => {
          reject(
            new Error(
              `codex review timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            ),
          );
        });
        return;
      }

      if (code !== 0) {
        settle(() => {
          reject(
            new Error(
              `codex review exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}: ${(stderr || stdout).substring(0, 1000)}`,
            ),
          );
        });
        return;
      }

      // With --output-format text, stdout is the model's raw text response
      const text = stdout.trim();
      if (!text) {
        settle(() => {
          reject(new Error('codex review returned empty output'));
        });
        return;
      }

      settle(() => {
        resolve(text);
      });
    });

    child.on('error', (err) => {
      if (timedOut || err.name === 'AbortError') {
        settle(() => {
          reject(
            new Error(
              `codex review timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            ),
          );
        });
        return;
      }

      settle(() => {
        reject(new Error(`Failed to spawn codex review: ${err.message}`));
      });
    });
  });
}

function buildClaudeJudgeSchema(): string {
  return JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['scores', 'reasoning'],
    properties: {
      scores: {
        anyOf: [
          {
            type: 'array',
            minItems: 1,
            items: {
              type: 'number',
              minimum: 0,
              maximum: 10,
            },
          },
          {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
              type: 'number',
              minimum: 0,
              maximum: 10,
            },
          },
        ],
      },
      reasoning: { type: 'string' },
      total: { type: 'number' },
      grade: { type: 'number' },
      auto_fail: { type: 'boolean' },
      violations: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  });
}

function runClaudeJudge(
  prompt: string,
  workingDirectory: string,
  model: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      buildClaudeJudgeSchema(),
      '--tools',
      '',
      '--permission-mode',
      'plan',
    ];

    if (model) {
      args.push('--model', model);
    }

    args.push(prompt);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    timeoutHandle.unref();
    let settled = false;
    let timedOut = false;

    const settle = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      handler();
    };

    controller.signal.addEventListener('abort', () => {
      timedOut = true;
    });

    const child = spawn(CLAUDE_JUDGE_BIN, args, {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      signal: controller.signal,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(() => {
          reject(
            new Error(
              `claude review timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            ),
          );
        });
        return;
      }

      if (code !== 0) {
        settle(() => {
          reject(
            new Error(
              `claude review exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}: ${(stderr || stdout).substring(0, 1000)}`,
            ),
          );
        });
        return;
      }

      const text = stdout.trim();
      if (!text) {
        settle(() => {
          reject(new Error('claude review returned empty output'));
        });
        return;
      }

      settle(() => {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (
            typeof parsed === 'object'
            && parsed !== null
            && 'structured_output' in parsed
            && typeof (parsed as { structured_output?: unknown }).structured_output === 'object'
            && (parsed as { structured_output?: unknown }).structured_output !== null
          ) {
            resolve(JSON.stringify((parsed as { structured_output: unknown }).structured_output));
            return;
          }

          resolve(text);
        } catch {
          resolve(text);
        }
      });
    });

    child.on('error', (err) => {
      if (timedOut || err.name === 'AbortError') {
        settle(() => {
          reject(
            new Error(
              `claude review timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            ),
          );
        });
        return;
      }

      settle(() => {
        reject(new Error(`Failed to spawn claude review: ${err.message}`));
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Core judge runner
// ---------------------------------------------------------------------------

async function runSingleJudge(
  prompt: string,
  workingDirectory: string,
  judgeConfig: JudgeConfig,
  model: string | undefined,
  reasoningEffort: string,
  timeoutMs: number,
  useRubric: boolean,
): Promise<JudgeRunResult> {
  const rawOutput = judgeConfig.mode === 'claude'
    ? await runClaudeJudge(
        prompt,
        workingDirectory,
        model,
        timeoutMs,
      )
    : await runCodexJudge(
        prompt,
        workingDirectory,
        model,
        reasoningEffort,
        timeoutMs,
      );

  const parsed = parseJudgeResponse(rawOutput);
  const total = parsed.scores.reduce((sum, s) => sum + s, 0);
  const averageScore = total / parsed.scores.length;

  // For rubric mode (0-2 per criterion), normalize to 0-10 scale
  // The rubric prompt asks for grade = total/30*10, but the reviewer may omit it
  const maxPossible = parsed.scores.length * 2; // rubric: 0-2 per item
  const normalizedScore = maxPossible > 0 ? (total / maxPossible) * 10 : 0;

  const grade = typeof parsed.raw.grade === 'number' && parsed.raw.grade >= 0 && parsed.raw.grade <= 10
    ? parsed.raw.grade
    : (averageScore <= 2 ? normalizedScore : averageScore); // Auto-detect rubric vs non-rubric scale
  const violations = Array.isArray(parsed.raw.violations)
    ? parsed.raw.violations.filter((violation): violation is string => typeof violation === 'string')
    : [];

  return {
    scores: parsed.scores,
    averageScore,
    aggregateScore: grade,
    autoFail: parsed.raw.auto_fail === true,
    violations,
    rawOutput,
  };
}

// ---------------------------------------------------------------------------
// Exported runner
// ---------------------------------------------------------------------------

export async function runAIJudge(
  config: Record<string, unknown>,
  context: ValidatorContext,
  judgeConfig: JudgeConfig,
): Promise<ValidationResult> {
  const criteria = config.criteria as string;
  const threshold = config.threshold as number;
  const maxVariance = config.max_variance as number | undefined;
  const evaluationTargets = (config.evaluation_targets as string[] | undefined) ?? [];
  const useRubric = (config.rubric as boolean | undefined) ?? false;
  const model = getJudgeModel(judgeConfig.model);
  const reasoningEffort = getJudgeReasoningEffort(judgeConfig.effortLevel);
  const timeoutMs = getJudgeTimeoutMs(config);

  const target = evaluationTargets.length > 0
    ? evaluationTargets.join(', ')
    : 'ai_judge';

  try {
    // If no evaluation targets specified, auto-discover source files
    let resolvedTargets = evaluationTargets;
    if (resolvedTargets.length === 0) {
      const { readdirSync, statSync } = await import('node:fs');
      const discoverFiles = (dir: string, prefix = ''): string[] => {
        const files: string[] = [];
        try {
          for (const entry of readdirSync(path.resolve(context.workingDirectory, dir))) {
            if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
            const rel = prefix ? `${prefix}/${entry}` : entry;
            const full = path.resolve(context.workingDirectory, rel);
            try {
              if (statSync(full).isDirectory()) {
                files.push(...discoverFiles(rel, rel));
              } else if (/\.(ts|tsx|js|jsx|py|rs|go)$/.test(entry) && !entry.endsWith('.d.ts')) {
                files.push(rel);
              }
            } catch { /* skip unreadable */ }
          }
        } catch { /* skip unreadable dirs */ }
        return files;
      };
      resolvedTargets = discoverFiles('.').slice(0, 20); // Cap at 20 files
    }

    if (resolvedTargets.length === 0) {
      return {
        type: 'ai_judge',
        target,
        passed: false,
        details: 'No source files found for AI judge evaluation. Add evaluation_targets to the validator config.',
      };
    }

    // Read all evaluation target files
    const fileContents = buildEvaluationPayload(
      resolvedTargets,
      context.workingDirectory,
    );

    const prompt = buildJudgePrompt(criteria, fileContents, useRubric);

    // Run judge 3 times for robustness (median-of-3)
    const NUM_RUNS = 3;
    const successfulRuns: SuccessfulJudgeRun[] = [];
    const failedRuns: JudgeRunFailure[] = [];

    const judgeRunResults = await Promise.allSettled(
      Array.from({ length: NUM_RUNS }, () =>
        runSingleJudge(
          prompt,
          context.workingDirectory,
          judgeConfig,
          model,
          reasoningEffort,
          timeoutMs,
          useRubric,
        ),
      ),
    );

    judgeRunResults.forEach((runResult, index) => {
      const run = index + 1;

      if (runResult.status === 'fulfilled') {
        successfulRuns.push({ run, result: runResult.value });
        return;
      }

      const message = runResult.reason instanceof Error
        ? runResult.reason.message
        : String(runResult.reason);
      failedRuns.push({ run, error: message });
    });

    if (successfulRuns.length === 0) {
      const infraMessage = failedRuns
        .map((run) => `run ${run.run}: ${run.error}`)
        .join('; ');
      throw new JudgeInfraError(
        `All ${NUM_RUNS} AI judge runs failed. ${infraMessage}`,
      );
    }

    const aggregateScores = successfulRuns.map((run) => run.result.aggregateScore);

    // Compute median of the successful run scores only
    const medianScore = median(aggregateScores);
    const scoreVariance = scoreSpread(aggregateScores);

    // Check variance constraint
    let varianceExceeded = false;
    if (maxVariance !== undefined && scoreVariance > maxVariance) {
      varianceExceeded = true;
    }

    // In rubric mode, auto_fail if a majority of successful runs flagged it
    const autoFailed = useRubric &&
      successfulRuns.filter((run) => run.result.autoFail).length > successfulRuns.length / 2;

    // Check threshold
    const meetsThreshold = medianScore >= threshold;
    const passed = meetsThreshold && !varianceExceeded && !autoFailed;

    const distinctViolations = [
      ...new Set(successfulRuns.flatMap((run) => run.result.violations)),
    ];

    const detailsObj: Record<string, unknown> = {
      judge_mode: judgeConfig.mode,
      judge_model: model ?? 'provider-default',
      rubric_mode: useRubric,
      timeout_ms: timeoutMs,
      median_score: medianScore,
      all_scores: aggregateScores,
      variance: scoreVariance,
      max_variance: maxVariance ?? null,
      threshold,
      passed,
      failed_runs: failedRuns.length,
      ...(autoFailed ? { auto_fail: true, auto_fail_reason: 'Critical rubric violation detected by majority of judges' } : {}),
      ...(distinctViolations.length > 0 ? { violations: distinctViolations } : {}),
      runs: [
        ...successfulRuns.map((run) => ({
          run: run.run,
          status: 'success',
          average_score: run.result.averageScore,
          aggregate_score: run.result.aggregateScore,
          individual_scores: run.result.scores,
          raw_output_hash: sha256(run.result.rawOutput),
        })),
        ...failedRuns.map((run) => ({
          run: run.run,
          status: 'failed',
          error: run.error,
        })),
      ],
    };

    return {
      type: 'ai_judge',
      target,
      passed,
      details: JSON.stringify(detailsObj, null, 2),
      optional: config.optional as boolean | undefined,
    };
  } catch (err) {
    if (err instanceof JudgeInfraError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);

    const errorDetails = {
      judge_mode: judgeConfig.mode,
      judge_model: model ?? 'provider-default',
      timeout_ms: timeoutMs,
      error: message,
      threshold,
    };

    return {
      type: 'ai_judge',
      target,
      passed: false,
      details: JSON.stringify(errorDetails, null, 2),
      optional: config.optional as boolean | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Validator class implementation
// ---------------------------------------------------------------------------

export class AiJudgeValidator implements Validator {
  type = 'ai_judge';

  private judgeConfig: JudgeConfig;

  constructor(judgeConfig?: JudgeConfig) {
    this.judgeConfig = judgeConfig ?? { mode: 'codex' };
  }

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    return runAIJudge(config, context, this.judgeConfig);
  }
}
