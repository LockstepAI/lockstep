import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createAgent } from '../agents/factory.js';
import {
  PARALLEL_MODELS,
  type SubTask,
  type SharedContracts,
  type TestSuite,
  type WorkerTestIteration,
} from './types.js';
import type { LanguageInfo } from './language-detect.js';
import { resolveParallelRoleModel } from './model-selection.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Test framework detection
// ---------------------------------------------------------------------------

interface TestFramework {
  name: string;
  run_command: string[];
  file_extension: string;
  file_prefix: string;
}

const TEST_FRAMEWORKS: Record<string, TestFramework> = {
  typescript: {
    name: 'vitest',
    run_command: ['npx', 'vitest', 'run', '--reporter=verbose'],
    file_extension: '.test.ts',
    file_prefix: '',
  },
  javascript: {
    name: 'vitest',
    run_command: ['npx', 'vitest', 'run', '--reporter=verbose'],
    file_extension: '.test.js',
    file_prefix: '',
  },
  python: {
    name: 'pytest',
    run_command: ['python3', '-m', 'pytest', '-v'],
    file_extension: '_test.py',
    file_prefix: 'test_',
  },
  go: {
    name: 'go test',
    run_command: ['go', 'test', '-v', './...'],
    file_extension: '_test.go',
    file_prefix: '',
  },
  rust: {
    name: 'cargo test',
    run_command: ['cargo', 'test', '--', '--test-output'],
    file_extension: '.rs',
    file_prefix: '',
  },
  java: {
    name: 'junit',
    run_command: ['mvn', 'test', '-pl', '.'],
    file_extension: 'Test.java',
    file_prefix: '',
  },
};

// ---------------------------------------------------------------------------
// Test Designer — generates tests from spec + contracts
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for the Test Designer agent.
 * The Test Designer generates tests based ONLY on the spec and contracts,
 * NOT on any implementation code. This decoupling prevents confirmation bias.
 */
export function buildTestDesignerPrompt(
  task: SubTask,
  contracts: SharedContracts,
  language: LanguageInfo,
): string {
  const framework = TEST_FRAMEWORKS[language.id];
  const frameworkName = framework?.name ?? 'appropriate test framework';

  const parts: string[] = [];

  parts.push(
    'You are a Test Designer agent. Your ONLY job is to write tests.',
    'You must generate a test suite based SOLELY on the task specification and shared contracts below.',
    'Do NOT write any implementation code. Write ONLY tests.',
    '',
    'CRITICAL: You are writing tests BEFORE the implementation exists.',
    'Your tests define the acceptance criteria that the implementation must satisfy.',
    'Base your tests on what the spec SAYS should happen, not on any guesses about HOW it will be implemented.',
    '',
    `Write tests using ${frameworkName} for ${language.name}.`,
    '',
    '## Shared Contracts',
    '',
    `\`\`\`${language.id}`,
    contracts.contracts_content,
    '```',
    '',
    '## Task Specification',
    '',
    `**${task.id}: ${task.name}**`,
    '',
    task.prompt,
    '',
    `**Files to be created/modified:** ${task.files.join(', ') || '(none)'}`,
    '',
    '## Test Requirements',
    '',
    '1. Write 3-8 focused test cases that verify the task specification.',
    '2. Test the PUBLIC interface — exported functions, classes, methods.',
    '3. Include at least one test for the happy path.',
    '4. Include at least one test for edge cases or error handling.',
    '5. Tests should import from the files listed above.',
    '6. Do NOT mock internal implementation details — test behavior, not structure.',
    '7. Each test should be independent and self-contained.',
    '',
    '## Output',
    '',
    'Output ONLY the test file content. No explanation, no markdown fences.',
    `Write valid ${language.name} test code that uses ${frameworkName}.`,
  );

  return parts.join('\n');
}

/**
 * Runs the Test Designer agent to generate a test suite for a sub-task.
 * Uses Sonnet (fast, cheap) since test generation is a structured task.
 */
export async function generateTestSuite(
  task: SubTask,
  contracts: SharedContracts,
  language: LanguageInfo,
  workingDirectory: string,
  timeout: number,
  agentType?: string,
  agentModel?: string,
): Promise<TestSuite | null> {
  const framework = TEST_FRAMEWORKS[language.id];
  if (!framework) return null; // No test framework for this language

  const agent = createAgent(agentType);
  const prompt = buildTestDesignerPrompt(task, contracts, language);

  const result = await agent.execute(prompt, {
    workingDirectory,
    timeout: Math.min(timeout, 60_000), // Cap at 60s — test gen should be fast
    model: resolveParallelRoleModel(agentType, PARALLEL_MODELS.architect, agentModel),
  });

  if (!result.success || !result.stdout.trim()) {
    return null;
  }

  // Strip markdown fences if present
  let testCode = result.stdout.trim();
  const fencedMatch = testCode.match(/```(?:\w+)?\s*\n([\s\S]*?)\n\s*```/);
  if (fencedMatch) {
    testCode = fencedMatch[1].trim();
  }

  // Determine test file path
  const primaryFile = task.files[0] ?? `${task.id}`;
  const baseName = path.basename(primaryFile, path.extname(primaryFile));
  const testFileName = framework.file_prefix
    ? `${framework.file_prefix}${baseName}${framework.file_extension}`
    : `${baseName}${framework.file_extension}`;
  const testFilePath = path.join('.lockstep', 'tests', testFileName);

  return {
    test_code: testCode,
    test_file_path: testFilePath,
    framework: framework.name,
    language: language.id,
  };
}

/**
 * Writes the test suite file into a worktree so workers can run it.
 */
export async function writeTestSuite(
  testSuite: TestSuite,
  worktreePath: string,
): Promise<string> {
  const fullPath = path.join(worktreePath, testSuite.test_file_path);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, testSuite.test_code, 'utf-8');
  return fullPath;
}

// ---------------------------------------------------------------------------
// Test execution — runs tests in a worktree
// ---------------------------------------------------------------------------

/**
 * Runs the test suite in a worktree and returns the result.
 */
export async function runTests(
  testSuite: TestSuite,
  worktreePath: string,
  timeout: number = 30_000,
): Promise<{ passed: boolean; output: string }> {
  const framework = TEST_FRAMEWORKS[testSuite.language];
  if (!framework) return { passed: true, output: 'No test framework available' };

  const testFilePath = path.join(worktreePath, testSuite.test_file_path);

  // Build the run command with the specific test file
  const command = [...framework.run_command];

  // For vitest/jest, append the test file path
  if (testSuite.language === 'typescript' || testSuite.language === 'javascript') {
    command.push(testFilePath);
  }
  // For pytest, append the test file path
  else if (testSuite.language === 'python') {
    command.push(testFilePath);
  }
  // For go/rust/java, tests run from the project root

  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
      cwd: worktreePath,
      timeout,
    });
    return { passed: true, output: stdout + (stderr ? `\n${stderr}` : '') };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract useful error output
    const errObj = err as { stdout?: string; stderr?: string };
    const output = [errObj.stdout, errObj.stderr, msg].filter(Boolean).join('\n');
    return { passed: false, output: output.slice(0, 2000) };
  }
}

// ---------------------------------------------------------------------------
// Test-first iteration loop
// ---------------------------------------------------------------------------

/**
 * Runs the test-first iteration loop for a single worker:
 * 1. Run tests after worker completes
 * 2. If tests fail, send error feedback to worker for re-implementation
 * 3. Repeat up to maxIterations times
 *
 * Returns the iteration history.
 */
export async function runTestFirstLoop(
  testSuite: TestSuite,
  _workerPrompt: string,
  worktreePath: string,
  timeout: number,
  maxIterations: number = 3,
  onOutput?: (text: string) => void,
  agentType?: string,
  agentModel?: string,
): Promise<WorkerTestIteration[]> {
  const iterations: WorkerTestIteration[] = [];

  // Write tests into the worktree
  await writeTestSuite(testSuite, worktreePath);

  // First test run (after initial worker execution)
  const firstResult = await runTests(testSuite, worktreePath, timeout);

  iterations.push({
    iteration: 1,
    tests_passed: firstResult.passed,
    test_output: firstResult.output.slice(0, 1000),
  });

  if (firstResult.passed) {
    return iterations;
  }

  // Iteration loop — worker gets error feedback and retries
  const agent = createAgent(agentType);

  for (let i = 2; i <= maxIterations; i++) {
    const lastOutput = iterations[iterations.length - 1].test_output;

    const retryPrompt = [
      'Your previous implementation failed the acceptance tests.',
      'Fix your code to make the tests pass. Do NOT modify the test file.',
      '',
      '## Test Failures',
      '',
      '```',
      lastOutput,
      '```',
      '',
      '## Test File Location',
      '',
      `The tests are at: ${testSuite.test_file_path}`,
      'Read the test file to understand what is expected, then fix your implementation.',
      '',
      'Fix the code. Do NOT explain — just fix it.',
    ].join('\n');

    const retryResult = await agent.execute(retryPrompt, {
      workingDirectory: worktreePath,
      timeout,
      model: resolveParallelRoleModel(agentType, PARALLEL_MODELS.worker, agentModel),
      onOutput,
    });

    if (!retryResult.success) {
      iterations.push({
        iteration: i,
        tests_passed: false,
        test_output: `Worker retry failed: ${retryResult.stderr.slice(0, 500)}`,
      });
      break;
    }

    // Run tests again
    const testResult = await runTests(testSuite, worktreePath, timeout);

    iterations.push({
      iteration: i,
      tests_passed: testResult.passed,
      test_output: testResult.output.slice(0, 1000),
    });

    if (testResult.passed) {
      break;
    }
  }

  return iterations;
}
