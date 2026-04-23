import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep, join } from 'node:path';
import { applyClaudeAuthMode, type ClaudeAuthMode, type ProviderName } from './providers.js';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const DEFAULT_JUDGE_REASONING_EFFORT = 'medium';
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
const JUDGE_RUN_COUNT = 3;
const MAX_INLINE_EVALUATION_CHARS = 12_000;
const TRUNCATED_HEAD_CHARS = 8_000;
const TRUNCATED_TAIL_CHARS = 3_000;

type JudgeResponse = {
  score?: number;
  scores?: number[] | Record<string, number>;
  reasoning: string;
  violations?: string[];
};

function isJudgeResponse(value: unknown): value is JudgeResponse {
  return typeof value === 'object' && value !== null && 'reasoning' in value;
}

function parseClaudeJudgeOutput(output: string): JudgeResponse {
  const parsed = JSON.parse(output) as unknown;
  if (
    typeof parsed === 'object'
    && parsed !== null
    && 'structured_output' in parsed
    && isJudgeResponse((parsed as { structured_output?: unknown }).structured_output)
  ) {
    return (parsed as { structured_output: JudgeResponse }).structured_output;
  }

  if (!isJudgeResponse(parsed)) {
    throw new Error('Claude judge returned an unexpected JSON envelope');
  }

  return parsed;
}

export type AiJudgeRunResult = {
  details?: string;
  passed: boolean;
};

type JudgeProviderConfig = {
  provider?: ProviderName;
  model?: string;
  claudeAuthMode?: ClaudeAuthMode;
};

function isPathWithinWorkingDirectory(resolvedPath: string, resolvedWorkingDirectory: string): boolean {
  if (resolvedPath === resolvedWorkingDirectory) {
    return true;
  }

  const normalizedWorkingDirectory = resolvedWorkingDirectory.endsWith(sep)
    ? resolvedWorkingDirectory
    : `${resolvedWorkingDirectory}${sep}`;

  return resolvedPath.startsWith(normalizedWorkingDirectory);
}

function resolveTargetPath(workingDirectory: string, target: string): string {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const resolvedPath = resolve(resolvedWorkingDirectory, target);

  if (!isPathWithinWorkingDirectory(resolvedPath, resolvedWorkingDirectory)) {
    throw new Error(`Path traversal detected for evaluation target: ${target}`);
  }

  return resolvedPath;
}

function normalizeEvaluationTargets(targets: string[]): string[] {
  return Array.from(new Set(
    targets
      .map((target) => target.trim())
      .filter((target) => target.length > 0),
  ));
}

function truncateEvaluationContent(content: string): string {
  if (content.length <= MAX_INLINE_EVALUATION_CHARS) {
    return content;
  }

  const head = content.slice(0, TRUNCATED_HEAD_CHARS);
  const tail = content.slice(-TRUNCATED_TAIL_CHARS);
  return [
    `[TRUNCATED: original length ${content.length} chars]`,
    head,
    '...[truncated]...',
    tail,
  ].join('\n');
}

export async function buildEvaluationPayload(
  workingDirectory: string,
  targets: string[],
): Promise<string> {
  const sections = await Promise.all(targets.map(async (target) => {
    try {
      const content = await readFile(resolveTargetPath(workingDirectory, target), 'utf-8');
      return `--- ${target} ---\n${truncateEvaluationContent(content)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `--- ${target} ---\n[ERROR: ${message}]`;
    }
  }));

  return sections.join('\n\n');
}

function getJudgeReasoningEffort(): string {
  const raw = process.env.LOCKSTEP_JUDGE_REASONING_EFFORT?.trim().toLowerCase()
    ?? process.env.LOCKSTEP_CODEX_REASONING_EFFORT?.trim().toLowerCase();
  return raw && VALID_REASONING_EFFORTS.has(raw)
    ? raw
    : DEFAULT_JUDGE_REASONING_EFFORT;
}

function buildJudgePrompt(
  criteria: string,
  payload: string,
  useRubric: boolean,
): string {
  const rubricSection = useRubric
    ? [
        '',
        'Use a production-readiness rubric. Be conservative, adversarial, and look for concrete weaknesses.',
        'List the most important violations explicitly.',
      ].join('\n')
    : '';

  return [
    'You are an expert code reviewer acting as an automated judge.',
    'Evaluate ONLY the supplied files against the criteria below.',
    'Do not run commands or ask for more context.',
    rubricSection,
    '',
    '## Criteria',
    criteria,
    '',
    '## Files',
    '```',
    payload,
    '```',
    '',
    'Return JSON only with:',
    '{"score": <number 0-10>, "reasoning": "<brief explanation>", "violations": ["<issue>", "..."]}',
  ].join('\n');
}

async function buildCodexSchemaFile(): Promise<string> {
  const schemaDir = await mkdtemp(join(tmpdir(), 'lockstep-client-ai-judge-'));
  const schemaPath = join(schemaDir, 'schema.json');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'reasoning', 'violations'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 10 },
      reasoning: { type: 'string', minLength: 1 },
      violations: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };

  await writeFile(schemaPath, JSON.stringify(schema), 'utf-8');
  return schemaPath;
}

function buildClaudeJudgeSchema(): string {
  return JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['score', 'reasoning', 'violations'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 10 },
      reasoning: { type: 'string', minLength: 1 },
      violations: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  });
}

async function runCodexJudgeOnce(
  prompt: string,
  workingDirectory: string,
  timeoutMs: number,
  model?: string,
): Promise<JudgeResponse> {
  const schemaPath = await buildCodexSchemaFile();

  try {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '--cd', workingDirectory,
      '-c',
      `model_reasoning_effort="${getJudgeReasoningEffort()}"`,
      '--output-schema',
      schemaPath,
    ];

    const resolvedModel = model?.trim() || process.env.LOCKSTEP_JUDGE_MODEL?.trim() || process.env.LOCKSTEP_CODEX_MODEL?.trim();
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    args.push('-');

    const output = await new Promise<string>((resolvePromise, rejectPromise) => {
      const proc = spawn(CODEX_BIN, args, {
        cwd: workingDirectory,
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGTERM');
        }, timeoutMs);
      }

      proc.stdin.write(prompt);
      proc.stdin.end();

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code, signal) => {
        if (timer) {
          clearTimeout(timer);
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          rejectPromise(new Error(`AI judge timed out after ${timeoutMs}ms`));
          return;
        }

        if (code !== 0) {
          rejectPromise(new Error(stderr.trim() || stdout.trim() || `Codex exited with code ${code ?? 1}`));
          return;
        }

        resolvePromise(stdout.trim());
      });

      proc.on('error', (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        rejectPromise(error);
      });
    });

    return JSON.parse(output) as JudgeResponse;
  } finally {
    await rm(dirname(schemaPath), { recursive: true, force: true });
  }
}

async function runClaudeJudgeOnce(
  prompt: string,
  workingDirectory: string,
  timeoutMs: number,
  model?: string,
  claudeAuthMode: ClaudeAuthMode = 'auto',
): Promise<JudgeResponse> {
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

  const resolvedModel = model?.trim();
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }

  args.push(prompt);

  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...applyClaudeAuthMode(process.env, claudeAuthMode),
        NO_COLOR: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
      }, timeoutMs);
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }

      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        rejectPromise(new Error(`Claude judge timed out after ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `Claude exited with code ${code ?? 1}`));
        return;
      }

      resolvePromise(stdout.trim());
    });

    proc.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      rejectPromise(error);
    });
  });

  return parseClaudeJudgeOutput(output);
}

function computeMedian(scores: number[]): number {
  const sorted = [...scores].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function runJudgeOnce(
  prompt: string,
  workingDirectory: string,
  timeoutMs: number,
  providerConfig: JudgeProviderConfig,
): Promise<JudgeResponse> {
  if (providerConfig.provider === 'claude') {
    return runClaudeJudgeOnce(
      prompt,
      workingDirectory,
      timeoutMs,
      providerConfig.model,
      providerConfig.claudeAuthMode,
    );
  }

  return runCodexJudgeOnce(
    prompt,
    workingDirectory,
    timeoutMs,
    providerConfig.model,
  );
}

export async function runAiJudge(
  config: {
    criteria: string;
    evaluation_targets?: string[];
    rubric?: boolean;
    threshold: number;
    timeout?: number;
    provider?: ProviderName;
    model?: string;
    claudeAuthMode?: ClaudeAuthMode;
  },
  workingDirectory: string,
): Promise<AiJudgeRunResult> {
  if (!config.evaluation_targets || config.evaluation_targets.length === 0) {
    return {
      passed: false,
      details: 'ai_judge requires evaluation_targets',
    };
  }

  const evaluationTargets = normalizeEvaluationTargets(config.evaluation_targets);
  const payload = await buildEvaluationPayload(workingDirectory, evaluationTargets);
  const prompt = buildJudgePrompt(config.criteria, payload, config.rubric === true);
  const timeoutMs = ((config.timeout ?? Math.round(DEFAULT_JUDGE_TIMEOUT_MS / 1000)) * 1000);

  try {
    const runs = await Promise.all(
      Array.from({ length: JUDGE_RUN_COUNT }, () => runJudgeOnce(prompt, workingDirectory, timeoutMs, {
        provider: config.provider ?? 'codex',
        model: config.model,
        claudeAuthMode: config.claudeAuthMode ?? 'auto',
      })),
    );

    const scores = runs.map((run) => typeof run.score === 'number'
      ? run.score
      : Array.isArray(run.scores)
        ? (run.scores.reduce((total, score) => total + score, 0) / Math.max(run.scores.length, 1))
        : typeof run.scores === 'object' && run.scores !== null
          ? (Object.values(run.scores).reduce((total, score) => total + Number(score), 0) / Math.max(Object.keys(run.scores).length, 1))
          : 0);
    const medianScore = computeMedian(scores);
    const passed = medianScore >= config.threshold;
    const violations = [...new Set(runs.flatMap((run) => run.violations ?? []))];

    return {
      passed,
      ...(passed
        ? {}
        : {
            details: JSON.stringify({
              median_score: medianScore,
              threshold: config.threshold,
              scores,
              reasoning: runs.map((run) => run.reasoning).join(' | '),
              violations,
            }),
          }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      details: `AI judge error: ${message}`,
    };
  }
}
