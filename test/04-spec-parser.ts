/**
 * Test 4: YAML parser with Zod validation works
 *   - Valid specs parse successfully
 *   - Invalid specs throw SpecValidationError
 */
import { parseSpec, validateSpec } from '../src/core/parser.js';
import { SpecValidationError } from '../src/utils/errors.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.resolve(import.meta.dirname, '..', '_test_tmp');
mkdirSync(TMP_DIR, { recursive: true });

let passed = true;
const failures: string[] = [];

function assert(label: string, condition: boolean) {
  if (!condition) {
    passed = false;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  } else {
    console.log(`  PASS: ${label}`);
  }
}

// --- Test: valid minimal spec ---
const validSpec = `
version: "1"
steps:
  - name: "Test step"
    prompt: "Do something"
    validate:
      - type: file_exists
        target: "package.json"
`;
const validPath = path.join(TMP_DIR, 'valid.yml');
writeFileSync(validPath, validSpec);

try {
  const spec = parseSpec(validPath);
  assert('Valid spec parses successfully', true);
  assert('Version is "1"', spec.version === '1');
  assert('Has 1 step', spec.steps.length === 1);
  assert('Step name is correct', spec.steps[0].name === 'Test step');
  assert('Config defaults are applied', spec.config.agent === 'codex');
  assert('Default max_retries is 3', spec.config.max_retries === 3);
  assert('Default step_timeout is 300', spec.config.step_timeout === 300);
} catch (err: any) {
  assert('Valid spec parses successfully', false);
  console.log(`    Error: ${err.message}`);
}

// --- Test: spec with all validator types ---
const fullSpec = `
version: "1"
config:
  agent: codex
  max_retries: 5
  step_timeout: 600
context: "A test project"
steps:
  - name: "Full validation step"
    prompt: "Build everything"
    validate:
      - type: file_exists
        target: "index.ts"
      - type: file_contains
        path: "index.ts"
        pattern: "export"
      - type: command_passes
        command: "echo hello"
`;
const fullPath = path.join(TMP_DIR, 'full.yml');
writeFileSync(fullPath, fullSpec);

try {
  const spec = parseSpec(fullPath);
  assert('Full spec parses with custom config', spec.config.max_retries === 5);
  assert('Context is preserved', spec.context === 'A test project');
  assert('Step has 3 validators', spec.steps[0].validate.length === 3);
} catch (err: any) {
  assert('Full spec parses successfully', false);
  console.log(`    Error: ${err.message}`);
}

// --- Test: public launch vocabulary aliases ---
const publicSpec = `
version: "1"
config:
  runner: codex
  autonomy: yolo
  effort_budget: 4
  phase_timeout: 120
  workspace: "."
brief: "Alias vocabulary"
phases:
  - name: "Foundation"
    prompt: "Create the base file"
    effort: 2
    signals:
      - signal: artifact_ready
        artifact: "package.json"
      - signal: artifact_match
        artifact: "package.json"
        expect: "name"
`;
const publicPath = path.join(TMP_DIR, 'public.yml');
writeFileSync(publicPath, publicSpec);

try {
  const spec = parseSpec(publicPath);
  assert('Public alias spec parses successfully', true);
  assert('runner alias maps to config.agent', spec.config.agent === 'codex');
  assert('autonomy alias maps to execution_mode', spec.config.execution_mode === 'yolo');
  assert('effort_budget alias maps to max_retries', spec.config.max_retries === 4);
  assert('phase_timeout alias maps to step_timeout', spec.config.step_timeout === 120);
  assert('phases alias maps to steps', spec.steps.length === 1);
  assert('signals alias maps to validate', spec.steps[0].validate.length === 2);
  assert('artifact_ready alias maps to file_exists', spec.steps[0].validate[0].type === 'file_exists');
  assert('artifact alias maps to target', (spec.steps[0].validate[0] as any).target === 'package.json');
  assert('artifact_match alias maps to file_contains', spec.steps[0].validate[1].type === 'file_contains');
  assert('expect alias maps to pattern', (spec.steps[0].validate[1] as any).pattern === 'name');
} catch (err: any) {
  assert('Public alias spec parses successfully', false);
  console.log(`    Error: ${err.message}`);
}

// --- Test: validator paths are normalized relative to working_directory ---
const workspaceRelativeSpec = `
version: "1"
config:
  working_directory: "github-action"
steps:
  - name: "Workspace scoped"
    prompt: "Fix the action"
    validate:
      - type: file_contains
        path: "github-action/src/index.ts"
        pattern: "ai_judge"
      - type: file_exists
        target: "github-action/action.yml"
      - type: ai_judge
        criteria: "Review the patch"
        threshold: 8
        evaluation_targets:
          - "github-action/src/index.ts"
          - "github-action/README.md"
`;
const workspaceRelativePath = path.join(TMP_DIR, 'workspace-relative.yml');
writeFileSync(workspaceRelativePath, workspaceRelativeSpec);

try {
  const spec = parseSpec(workspaceRelativePath);
  const firstValidator = spec.steps[0].validate[0] as any;
  const secondValidator = spec.steps[0].validate[1] as any;
  const judgeValidator = spec.steps[0].validate[2] as any;
  assert('working_directory file paths are stripped to workspace-relative form', firstValidator.path === 'src/index.ts');
  assert('working_directory file targets are stripped to workspace-relative form', secondValidator.target === 'action.yml');
  assert(
    'working_directory judge targets are stripped to workspace-relative form',
    Array.isArray(judgeValidator.evaluation_targets)
      && judgeValidator.evaluation_targets[0] === 'src/index.ts'
      && judgeValidator.evaluation_targets[1] === 'README.md',
  );
} catch (err: any) {
  assert('workspace-relative spec parses successfully', false);
  console.log(`    Error: ${err.message}`);
}

// --- Test: invalid spec - missing version ---
const noVersion = `
steps:
  - name: "Test"
    prompt: "Do"
    validate:
      - type: file_exists
        target: "x"
`;
const noVersionPath = path.join(TMP_DIR, 'no-version.yml');
writeFileSync(noVersionPath, noVersion);

try {
  parseSpec(noVersionPath);
  assert('Missing version throws SpecValidationError', false);
} catch (err) {
  assert('Missing version throws SpecValidationError', err instanceof SpecValidationError);
}

// --- Test: invalid spec - no steps ---
const noSteps = `
version: "1"
steps: []
`;
const noStepsPath = path.join(TMP_DIR, 'no-steps.yml');
writeFileSync(noStepsPath, noSteps);

try {
  parseSpec(noStepsPath);
  assert('Empty steps throws SpecValidationError', false);
} catch (err) {
  assert('Empty steps throws SpecValidationError', err instanceof SpecValidationError);
}

// --- Test: invalid spec - ai_judge as sole validator ---
const aiJudgeOnly = `
version: "1"
steps:
  - name: "AI only"
    prompt: "Do something"
    validate:
      - type: ai_judge
        criteria: "Code quality"
        threshold: 7
`;
const aiJudgeOnlyPath = path.join(TMP_DIR, 'ai-judge-only.yml');
writeFileSync(aiJudgeOnlyPath, aiJudgeOnly);

try {
  parseSpec(aiJudgeOnlyPath);
  assert('ai_judge as sole validator throws SpecValidationError', false);
} catch (err) {
  assert('ai_judge as sole validator throws SpecValidationError', err instanceof SpecValidationError);
}

// --- Test: validateSpec non-throwing wrapper ---
const result = validateSpec(noVersionPath);
assert('validateSpec returns { valid: false } for invalid spec', result.valid === false);
assert('validateSpec includes error messages', Array.isArray(result.errors) && result.errors.length > 0);

const validResult = validateSpec(validPath);
assert('validateSpec returns { valid: true } for valid spec', validResult.valid === true);

// --- Test: nonexistent file ---
try {
  parseSpec('/nonexistent/path/file.yml');
  assert('Nonexistent file throws SpecValidationError', false);
} catch (err) {
  assert('Nonexistent file throws SpecValidationError', err instanceof SpecValidationError);
}

// --- Cleanup ---
unlinkSync(validPath);
unlinkSync(fullPath);
unlinkSync(publicPath);
unlinkSync(workspaceRelativePath);
unlinkSync(noVersionPath);
unlinkSync(noStepsPath);
unlinkSync(aiJudgeOnlyPath);
try { const { rmdirSync } = await import('node:fs'); rmdirSync(TMP_DIR); } catch {}

// --- Summary ---
if (passed) {
  console.log('PASS: All spec parser checks passed');
} else {
  console.log(`FAIL: ${failures.length} spec parser check(s) failed`);
}

process.exit(passed ? 0 : 1);
