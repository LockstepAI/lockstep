import { spawn } from 'node:child_process';
import * as yaml from 'js-yaml';
import {
  LockstepSpecSchema,
  type LockstepSpec,
  type LockstepStep,
  type LockstepValidator,
  normalizeSpecWorkingDirectoryPaths,
} from '../core/parser.js';
import { canonicalizeSpecInput } from '../core/public-surface.js';
import {
  getGenerateModel,
  getGenerateMaxAttempts,
  getGenerateReasoningEffort,
} from '../utils/env.js';

// ---------------------------------------------------------------------------
// System prompt for spec generation
// ---------------------------------------------------------------------------

const OUTPUT_CONTRACT = `You MUST return a SINGLE YAML document with this exact top-level structure:

\`\`\`yaml
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      config:
        agent: codex
        max_retries: 3
        step_timeout: 300
        working_directory: "."
      context: |
        Optional shared context.
      steps:
        - name: Example step
          prompt: |
            Detailed instructions.
          validate:
            - type: file_exists
              target: package.json
\`\`\`

Rules for this output contract:
- Always return a top-level \`specs\` array, even for a single spec
- Each \`filename\` must end in \`.yml\`
- Each \`spec\` value must be a YAML mapping/object, not a string containing YAML
- Do NOT emit comments, markdown fences, \`---SPLIT---\`, or multiple YAML documents
- Use spaces for indentation, never tabs
- Return YAML only with no explanatory text`;

const SYSTEM_PROMPT = `You are a Lockstep spec generator. Your job is to analyze a user's prompt/requirements and decompose it into one or more valid Lockstep YAML specs.

## Lockstep Spec Format

A Lockstep spec is a YAML file with this structure:

\`\`\`yaml
version: "1"
config:
  agent: codex
  max_retries: 3
  step_timeout: 300
  working_directory: "."
context: |
  Optional global context for all steps.
steps:
  - name: Step name
    prompt: |
      Detailed instructions for what the agent should do.
    pre_commands:  # optional
      - "npm install"
    post_commands:  # optional
      - "npm run format"
    validate:
      - type: file_exists
        target: src/index.ts
      - type: file_contains
        path: src/index.ts
        pattern: "export default"
      - type: command_passes
        command: "npm run build"
      - type: test_passes
        command: "npm test"
      - type: ai_judge
        criteria: |
          Evaluate if the code follows best practices.
        threshold: 7.0
        evaluation_targets:
          - src/index.ts
\`\`\`

## Available Validators

1. **file_exists** - Check a file exists. Fields: \`target\` (path)
2. **file_not_exists** - Check a file does NOT exist. Fields: \`target\` (path)
3. **file_contains** - Check file contains a pattern. Fields: \`path\`, \`pattern\`, \`is_regex\` (optional bool)
4. **file_not_contains** - Check file does NOT contain pattern. Fields: \`path\`, \`pattern\`, \`is_regex\` (optional bool)
5. **command_passes** - Check a shell command exits 0. Fields: \`command\`, \`timeout\` (optional)
6. **command_output** - Check command output matches pattern. Fields: \`command\`, \`pattern\`, \`is_regex\` (optional bool)
7. **api_responds** - Check an HTTP endpoint. Fields: \`url\`, \`status\`, \`body_contains\` (optional)
8. **json_valid** - Check a JSON file is valid. Fields: \`path\`
9. **type_check** - Run type checking. Fields: \`command\` (optional, defaults to tsc)
10. **lint_passes** - Run linter. Fields: \`command\` (optional)
11. **test_passes** - Run tests. Fields: \`command\`, \`timeout\` (optional)
12. **ai_judge** - AI evaluation (median-of-3). REQUIRED fields: \`criteria\` (string, MUST NOT be empty), \`threshold\` (number 0-10), \`evaluation_targets\` (array of file paths to evaluate — ALWAYS include this, list the source files the step changes or creates). Optional: \`max_variance\`, \`rubric\` (bool). The judge reviews git diffs for changed targets when available, otherwise current file contents. CANNOT be the only validator on a step.

## CRITICAL: ai_judge rules

Every \`ai_judge\` validator MUST include ALL THREE:
- \`criteria\`: a non-empty string describing what to evaluate
- \`threshold\`: a number between 0 and 10
- \`evaluation_targets\`: an array of file paths that the judge should read and evaluate (list the files this step creates/modifies)

Missing \`evaluation_targets\` means the judge evaluates EMPTY content and scores 0. This is the #1 cause of false failures. ALWAYS list the specific source files.

Example:
\`\`\`yaml
- type: ai_judge
  criteria: |
    Evaluate code quality and error handling.
  threshold: 7.0
  evaluation_targets:
    - src/server.ts
    - src/utils.ts
  rubric: true
\`\`\`

## Rules

1. Every step MUST have at least one structural validator (not just ai_judge)
2. Steps should be ordered so each builds on the previous
3. Each step's prompt should be detailed and self-contained
4. Step names should be short and descriptive
5. Prompts should be specific about what to create, not vague
6. NEVER use \`command_output\` validator. It is fragile with piped commands, ANSI codes, and test runners. Use \`test_passes\` to verify tests pass, \`command_passes\` to verify commands succeed, and \`file_contains\` to check file content. The \`command_output\` validator should not appear in generated specs.
7. ONLY include ai_judge on the FINAL step — not on intermediate steps. Intermediate steps should use structural validators only (file_exists, file_contains, command_passes, test_passes). The final step is the quality gate.
8. When generating multiple specs, maintain consistent quality on ALL specs — do NOT drop required fields on later specs
9. ai_judge threshold on the final step should be 8.0 — we ship production-grade code only. Use rubric mode for broad production-readiness reviews. For narrow bugfixes, keep criteria task-specific so the judge evaluates the patch rather than unrelated legacy code.
10. \`file_contains\`, \`file_not_contains\`, and \`json_valid\` validators MUST target a single file path, never a directory. If you need to assert something across a directory tree, use \`command_passes\` with \`rg\`, \`find\`, or the project test/lint command instead.
11. Every step MUST be realistically completable within the configured \`step_timeout\`. Keep each step to one concrete deliverable with a small validator set. If a prompt asks for multiple packages, services, or surfaces, split them into separate steps or separate specs instead of combining them into one giant scaffold step.
12. For monorepos and multi-surface products, prefer separate phases such as root workspace, shared package, API package, runner/SDK package, and CI/release plumbing. Do NOT ask the agent to build the entire monorepo, API, SDK, runner, and CI stack in a single step.
13. Validators MUST match the implementation strategy chosen in the prompt. If the step uses \`pnpm-workspace.yaml\`, validate that file instead of requiring a \`workspaces\` field in \`package.json\`. If the step uses \`tsconfig.base.json\` plus \`tsconfig.workspace.json\`, either validate those files directly or add a root \`tsconfig.json\` wrapper on purpose.
14. Early scaffold/foundation steps MUST avoid tool-dependent validators that require installed dependencies unless the step also includes the necessary \`pre_commands\` to install them with the chosen package manager. Do NOT assume \`npx tsc\`, \`npx prettier\`, or \`npm test\` will work in a fresh workspace without install/setup.
15. When a step only creates scaffolding, prefer structural validators first: required files, expected config content, and package boundaries. Save full lint/typecheck/test commands for a later step after dependencies and workspace linking exist.
16. Validate configuration in the file that actually owns it. Example: TypeScript strict flags belong in \`tsconfig*.json\`, not \`package.json\`. Workspace config belongs in \`package.json\` or \`pnpm-workspace.yaml\` depending on the chosen package manager.
17. The agent executes inside a workspace-write sandbox with NO network access. Scaffold/foundation prompts MUST explicitly tell the agent not to run \`pnpm install\`, \`npm install\`, \`yarn install\`, \`bun install\`, \`npx\`, \`corepack\`, or any other dependency-download command during that step. Only create/edit files in scaffold steps.
18. If a later step needs dependencies for lint/typecheck/test validators, install them via \`pre_commands\` on the host runner before the agent step. Do NOT rely on the agent to fetch packages from inside the sandbox.
19. For pnpm monorepo scaffolds, use \`pnpm-workspace.yaml\` as the single source of truth for workspace membership. Do NOT also add a root \`package.json.workspaces\` field unless the prompt explicitly requires it.
20. If a package manifest exports \`./dist/index.js\` and \`./dist/index.d.ts\`, the package TypeScript config MUST align with that output layout: \`rootDir: "./src"\`, \`outDir: "./dist"\`, and source entrypoint at \`src/index.ts\`.
21. Package build configs MUST NOT compile tests into runtime artifacts. Keep tests outside the emitted package build graph unless the prompt explicitly asks for bundled tests.
22. Placeholder tests in scaffold steps MUST be real and must match the declared test script exactly. Prefer \`test/index.test.ts\` for TypeScript packages. Do NOT generate extra JS shim tests like \`smoke.test.js\` unless the spec explicitly asks for them.
23. Root and package scripts must be coherent from a fresh checkout. Do not declare scripts that point at missing files, mismatched test paths, or config files that are not created in the same step.
24. Root workspace scripts must orchestrate real package workflows. Do NOT invent helper scripts like \`test:placeholders\` that bypass the declared package \`test\` scripts, and do NOT add watch/dev scripts unless the referenced package scripts actually exist.
25. If root \`tsconfig.json\` is the intended \`tsc -b\` entrypoint, keep it as a solution-style reference graph and do NOT set \`noEmit: true\` there. Use a separate no-emit config (for example \`tsconfig.eslint.json\`) when needed.
26. When you add \`prettier.config.*\` or other formatter config files, you MUST also add the formatter package to devDependencies and wire runnable root scripts such as \`format\` and \`format:check\`.
27. Avoid shell-specific cleanup commands such as \`rm -rf\` in scaffold package scripts. Use cross-platform Node-based cleanup or another portable approach.
28. If package tests are excluded from package build tsconfig files, still provide an explicit strict workflow for those test files via root lint/test configuration or dedicated test tsconfig files. Do not leave test TypeScript outside every declared validation boundary.

## LOCKSTEP PRODUCTION RULES ENGINE (MANDATORY)

You are a senior engineer writing specs. Every spec you generate MUST enforce these non-negotiable production rules. The agent CANNOT ship code that violates them — validators will catch violations and the build will retry until fixed.

### RULE SET 1: Code Quality (every step's prompt MUST require these)
- CQ-001: No \`any\` type — use \`unknown\` with type guards
- CQ-002: No non-null assertions (\`!\`) — use proper null checks
- CQ-003: Explicit return types on all exported functions
- CQ-004: No unused variables or imports
- CQ-005: Proper error subclassing (extends Error, set name property)
- CQ-006: No console.log in production code — use structured logger
- CQ-007: No floating promises — must await or void every promise
- CQ-008: No magic numbers — extract to named constants
- CQ-009: Max 4 parameters per function — use options object for more
- CQ-010: No synchronous file I/O in async contexts

### RULE SET 2: Security (enforce via file_not_contains + command_passes validators)
- SEC-001: No hardcoded secrets, API keys, or passwords in source files
- SEC-002: Parameterized queries ALWAYS — never string concatenation for SQL
- SEC-003: No \`eval()\`, \`Function()\`, or \`vm.runInNewContext()\` with user input
- SEC-004: Path traversal prevention — resolve paths and check prefix
- SEC-005: No dangerouslySetInnerHTML/v-html/@html without DOMPurify
- SEC-006: Input validation with Zod/Joi at all external boundaries
- SEC-007: Generic error messages on auth failure — never reveal if user exists
- SEC-008: CORS must use explicit origins — never wildcard with credentials
- SEC-009: Cookies must be httpOnly, secure, sameSite=strict
- SEC-010: Rate limiting on authentication and expensive endpoints

### RULE SET 3: Testing (enforce via test_passes + ai_judge validators)
- TST-001: No tautological assertions (assert(true), expect(x).toBe(x))
- TST-002: Every try/catch MUST have a test that triggers the catch path
- TST-003: Boundary value tests — test 0, -1, empty string, null, MAX_INT
- TST-004: Tests must be independent — no shared mutable state between tests
- TST-005: Async tests must properly await — no floating promises
- TST-006: Error message assertions — test the actual error message/code
- TST-007: No snapshot tests of dynamic content (timestamps, UUIDs)
- TST-008: Coverage: aim for 80% statements, 70% branches

### RULE SET 4: API/Server (enforce via file_contains + command_passes validators)
- API-001: Graceful shutdown with SIGTERM/SIGINT handlers and connection draining
- API-002: Health check endpoint (/health) that verifies dependencies
- API-003: Request ID middleware — generate or propagate X-Request-ID
- API-004: Structured JSON logging with timestamp, level, requestId, duration
- API-005: Request body size limits — reject oversized payloads
- API-006: Request timeout middleware — kill slow requests
- API-007: Consistent error response schema: { error: { code, message } }
- API-008: Timeout on ALL external HTTP/DB calls — never wait forever
- API-009: Proper HTTP status codes — don't return 200 for errors

### RULE SET 5: Database (when applicable)
- DB-001: Parameterized queries only — no string concatenation
- DB-002: N+1 query prevention — use eager loading or joins
- DB-003: Transactions for multi-step mutations — atomic operations
- DB-004: NOT NULL by default — nullable must be explicit
- DB-005: Audit timestamps on all tables — created_at, updated_at

### RULE SET 6: Frontend (when applicable)
- FE-001: All images must have alt text
- FE-002: Interactive elements need keyboard support (onClick + onKeyDown)
- FE-003: Semantic HTML — use button/nav/main, not div soup
- FE-004: Form inputs must have associated labels
- FE-005: No direct state mutation (React: use setState, not this.state.x = y)

### LANGUAGE-AWARE ENFORCEMENT

Detect the language/stack from the user's prompt and use the appropriate toolchain:

| Language | Type Check | Lint | Test | Formatter |
|----------|-----------|------|------|-----------|
| TypeScript/Node | \`npx tsc --noEmit --strict\` | \`npx eslint . --max-warnings 0\` | \`npm test\` | \`npx prettier --check .\` |
| Python | \`mypy . --strict\` | \`ruff check .\` | \`pytest -v\` | \`ruff format --check .\` |
| Rust | \`cargo check\` | \`cargo clippy -- -D warnings\` | \`cargo test\` | \`cargo fmt --check\` |
| Go | \`go vet ./...\` | \`golangci-lint run\` | \`go test ./...\` | \`gofmt -l .\` |
| Java/Kotlin | \`./gradlew compileJava\` | \`./gradlew checkstyleMain\` | \`./gradlew test\` | — |

Always use the correct commands for the detected language. NEVER hardcode TypeScript-only validators.

### HOW TO ENFORCE RULES IN SPECS

Every step MUST include validators that enforce the relevant rules. Adapt file paths and commands to the language detected from the prompt.

**Type safety (adapt to language):**
\`\`\`yaml
# TypeScript
- type: command_passes
  command: "npx tsc --noEmit --strict"
# Python
- type: command_passes
  command: "mypy . --strict"
# Rust
- type: command_passes
  command: "cargo clippy -- -D warnings"
\`\`\`

**No hardcoded secrets (language-agnostic):**
\`\`\`yaml
- type: file_not_contains
  path: src/config.ts  # adapt path to language
  pattern: "sk_live_|sk_test_|password.*=.*['\"]|PRIVATE.KEY"
  is_regex: true
\`\`\`

**Tests with failure path coverage:**
\`\`\`yaml
- type: test_passes
  command: "npm test"  # or pytest, cargo test, go test
- type: ai_judge
  criteria: |
    Evaluate test quality:
    1. Are failure paths tested (not just happy path)?
    2. Are boundary values tested (0, -1, empty, null/None/nil)?
    3. Are error messages asserted?
    4. No tautological assertions?
    5. Tests are independent and deterministic?
  threshold: 7.0
  rubric: true
  evaluation_targets:
    - src/__tests__/main.test.ts  # adapt to language test paths
\`\`\`

**Security validation (language-agnostic patterns):**
\`\`\`yaml
- type: file_not_contains
  path: src/auth.ts  # adapt path
  pattern: "eval\\\\(|exec\\\\(|Function\\\\("
  is_regex: true
\`\`\`

**Graceful shutdown (adapt signal handling to language):**
\`\`\`yaml
- type: file_contains
  path: src/index.ts  # or main.py, main.go, main.rs
  pattern: "SIGTERM"
\`\`\`

### MANDATORY FINAL STEP

The LAST step of every spec MUST include a comprehensive ai_judge with rubric: true that evaluates ALL applicable rules. Threshold MUST be 8.0 or higher:

\`\`\`yaml
- type: ai_judge
  criteria: |
    Evaluate against Lockstep Production Rules:
    1. Type safety: strict types, no unsafe casts, proper error types
    2. Security: No hardcoded secrets, parameterized queries, input validation
    3. Error handling: Custom errors, proper error boundaries, no swallowed errors
    4. Testing: Failure paths tested, boundary values, no tautological assertions
    5. API quality: Graceful shutdown, health check, structured logging, timeouts
    6. Code organization: Single responsibility, no magic numbers, clean imports
  threshold: 7.0
  rubric: true
  evaluation_targets:
    - src/index.ts
    - src/server.ts
\`\`\`

## Complexity Splitting

When a task is too complex for a single spec (more than ~6 steps, multiple packages, or clearly distinct phases), split into multiple specs. Each spec should be a complete, self-contained phase with steps that can pass validators inside the default timeout budget.

Examples of good splitting:
- root workspace + shared tooling
- shared package baseline
- API package
- terminal runner / SDK package
- CI / release automation

Examples of bad splitting:
- one step that asks for the entire monorepo scaffold plus API plus runner plus SDK plus CI
- directory-wide content checks using \`file_contains\` or \`file_not_contains\`

## Output Format

You MUST respond with ONLY valid YAML. No explanation, no markdown fences, no commentary.

${OUTPUT_CONTRACT}`;

const REPAIR_PROMPT = `The previous response was not valid for Lockstep generation. Rewrite it as valid YAML that follows the output contract exactly.

${OUTPUT_CONTRACT}

COMMON MISTAKES TO FIX:
- Every ai_judge MUST have both \`criteria\` (non-empty string) and \`threshold\` (number). Missing criteria is the #1 failure.
- Every spec MUST have \`version: "1"\` (string, not number).
- Every spec MUST have a \`steps\` array with at least one step.
- Every step MUST have at least one non-ai_judge validator.
- The top-level key must be \`specs:\` containing an array of {filename, spec} objects.
- \`file_contains\`, \`file_not_contains\`, and \`json_valid\` validators must point to FILES, not directories.
- If a step is trying to create too much at once, split it into smaller phases so each step is executable within the default timeout budget.
- Validators must match the chosen package-manager and tsconfig strategy. Do not require \`workspaces\` in \`package.json\` if the spec chose \`pnpm-workspace.yaml\`, and do not require root \`tsconfig.json\` unless the spec creates it.
- Do not use tool-dependent validators on a fresh workspace unless the spec also installs dependencies first via \`pre_commands\`.
- Scaffold/foundation prompts must explicitly forbid dependency installation or other network-requiring package-manager commands inside the agent sandbox.
- When a later step uses command/test/lint/typecheck validators against a workspace created earlier, add a host-side install command in \`pre_commands\`.
- Validate config in the correct file. Do not check TypeScript strict mode in \`package.json\`; check the relevant \`tsconfig*.json\` file instead.
- For pnpm monorepos, do not duplicate workspace membership in both \`pnpm-workspace.yaml\` and \`package.json.workspaces\`.
- If package manifests export \`dist/index.*\`, make the package tsconfig emit exactly that layout with \`rootDir: "./src"\` and \`outDir: "./dist"\`.
- Do not compile tests into package runtime outputs, and do not generate fake test entrypoints. Placeholder tests must exist and must match the declared test script exactly.
- Do not add root helper scripts that bypass the declared package workflow surface. Root \`test\` and watch scripts should orchestrate package scripts, not invent a second contract.
- If root \`tsconfig.json\` is used for \`tsc -b\`, keep it as a solution-style reference graph without \`noEmit: true\`.
- When you add formatter config files, also add the formatter dependency and runnable root format scripts.
- Do not use shell-specific cleanup commands like \`rm -rf\` in generated package scripts.

Keep the same task intent, preserve any sensible filenames, and fix structure/indentation/quoting issues.
Return YAML only.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedSpec {
  filename: string;
  content: string;
  stepCount: number;
  stepNames: string[];
}

export interface GenerateResult {
  specs: GeneratedSpec[];
  multiFile: boolean;
}

export interface GenerateCallbacks {
  onAnalyzing?: () => void;
  onGenerating?: () => void;
  onOutput?: (text: string) => void;
  onRetry?: (info: { attempt: number; maxAttempts: number; reason: string }) => void;
}

export interface GenerateOptions {
  callbacks?: GenerateCallbacks;
  timeoutMs?: number;
  maxAttempts?: number;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

// ---------------------------------------------------------------------------
// Parse the generated output
// ---------------------------------------------------------------------------

function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```yaml')) {
    cleaned = cleaned.replace(/^```yaml\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```yml')) {
    cleaned = cleaned.replace(/^```yml\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/, '');
  }

  return cleaned.trim();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatSchemaIssues(specLabel: string, issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${specLabel}.${path}: ${issue.message}`;
    })
    .join('; ');
}

function normalizeFilename(filename: unknown, index: number): string {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }

  if (index === 0) {
    return '.lockstep.yml';
  }

  return `lockstep-${String(index + 1).padStart(2, '0')}.yml`;
}

function dumpSpec(spec: LockstepSpec): string {
  return yaml.dump(spec, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  }).trim();
}

function toGeneratedSpec(spec: LockstepSpec, filename: string): GeneratedSpec {
  return {
    filename,
    content: dumpSpec(spec),
    stepCount: spec.steps.length,
    stepNames: spec.steps.map((step) => step.name),
  };
}

const STRUCTURAL_VALIDATOR_TYPES = new Set([
  'file_exists',
  'file_not_exists',
  'file_contains',
  'file_not_contains',
  'json_valid',
]);

const INSTALL_REQUIRING_VALIDATOR_TYPES = new Set([
  'command_passes',
  'test_passes',
  'lint_passes',
  'type_check',
]);

const SCAFFOLD_VALIDATOR_TYPES = new Set([
  ...STRUCTURAL_VALIDATOR_TYPES,
  'ai_judge',
]);

const SANDBOXED_SCAFFOLD_NOTE = [
  'Important: this step runs inside a workspace-write sandbox with no network access.',
  'Do not run `pnpm install`, `npm install`, `yarn install`, `bun install`, `npx`, `corepack`, or any other dependency-download command in this step.',
  'Only create or edit the repository files needed for the scaffold.',
].join(' ');

const PNPM_MONOREPO_NOTE = [
  'For pnpm monorepos, use `pnpm-workspace.yaml` as the only workspace-membership source of truth.',
  'Do not add `package.json.workspaces` unless the task explicitly requires it.',
  'If package manifests export `dist/index.*`, package tsconfig files must use `rootDir: "./src"` and `outDir: "./dist"`.',
  'Keep emitted dist artifacts self-contained. For minimal scaffolds, prefer `sourceMap` and `declarationMap` off unless those map files are intentionally part of the published contract and validation surface.',
  'Keep placeholder tests real and consistent with the declared script, preferably `test/index.test.ts`, and do not emit tests as runtime build artifacts.',
  'When the workspace includes root and package Vitest placeholder suites, add an explicit root `vitest.config.ts` that pins the workspace root and defines separate `root` and `packages` Vitest projects.',
  'Root and package test workflows must stay aligned; root test scripts should target the `root` project, and package test scripts should either target dedicated package-scoped Vitest projects or target the shared `packages` project with package-local test paths so they stay credible from package directories.',
  'Default root watch/dev/test:watch entrypoints must stay believable for a monorepo. Do not make the default watch loop ignore package workflows when package watch scripts exist.',
  'Avoid redundant root helper aliases that compete with the default workflow contract. If helper variants such as `watch:packages` or `test:packages` exist, they must stay explicit alternates and mirror the same package surfaces as the default workflows instead of introducing a second conflicting model.',
  'Root scripts should orchestrate package scripts directly; do not invent root-only placeholder test helpers that drift from package-level contracts.',
  'Keep `typecheck` non-emitting and distinct from `build`; do not make typecheck depend on emitted dist artifacts.',
  'Root lint coverage should include every root workflow/config file it depends on, including helper scripts and `vitest.config.ts` when present.',
  'Root clean workflows should remove incremental build artifacts for the root config surfaces they own, including root tsconfig and type-aware lint tsbuildinfo files when those configs are part of the scaffold.',
  'If you provide a shared clean helper, it must refuse relative paths that escape the caller working directory.',
  'Type-aware lint and package typecheck for workspace package imports must be believable from a clean checkout: either resolve package names to source files via explicit shared tsconfig paths, or make any required solution-build dependency explicit in the script surface. Do not rely on hidden sibling prebuilds or undeclared dist artifacts.',
  'Package tests should stay independently runnable under the shared Vitest workspace config and should prove the published package contract from a clean checkout. A mixed strategy is acceptable when it is coherent: source-based behavior checks plus explicit built-entrypoint or emitted `dist/index.*` assertions.',
  'If `tsconfig.json` is the root `tsc -b` entrypoint, keep it as a reference-only solution config without `noEmit: true`.',
  'When root `tsconfig.json` is a project-reference graph, keep default root build, typecheck, and watch workflows solution-style and believable from a clean checkout.',
  'Commit `pnpm-lock.yaml` for reproducible installs and treat it as part of the scaffold contract.',
  'When adding Prettier config, also add the `prettier` dependency plus runnable root `format` and `format:check` scripts.',
  'Package manifests should expose a coherent script surface for build, clean, format, lint, test, typecheck, and watch when those workflows are part of the scaffold contract.',
  'Use cross-platform cleanup commands in package scripts instead of shell-specific `rm -rf`.',
].join(' ');

function appendPromptNote(prompt: string, note: string): string {
  if (prompt.includes(note)) {
    return prompt;
  }

  return `${prompt.trimEnd()}\n\n${note}`;
}

function detectPackageManager(spec: LockstepSpec): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const haystacks = [
    spec.context ?? '',
    ...spec.steps.flatMap((step) => [
      ...(step.pre_commands ?? []),
      ...(step.post_commands ?? []),
      ...step.validate.map((validator) => [
        'command' in validator && typeof validator.command === 'string' ? validator.command : '',
        'target' in validator && typeof validator.target === 'string' ? validator.target : '',
        'path' in validator && typeof validator.path === 'string' ? validator.path : '',
      ].join('\n')),
    ]),
  ].join('\n').toLowerCase();

  if (haystacks.includes('pnpm-workspace.yaml') || /\bpnpm\b/.test(haystacks)) {
    return 'pnpm';
  }
  if (/\byarn\b/.test(haystacks)) {
    return 'yarn';
  }
  if (/\bbun\b/.test(haystacks)) {
    return 'bun';
  }
  return 'npm';
}

function getInstallCommand(packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm'): string {
  switch (packageManager) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    default:
      return 'npm install';
  }
}

function hasInstallPreCommand(commands: string[] | undefined): boolean {
  return (commands ?? []).some((command) => /\b(pnpm|npm|yarn|bun)\b.*\binstall\b/i.test(command));
}

function isStructuralStep(step: LockstepSpec['steps'][number]): boolean {
  return step.validate.every((validator) => STRUCTURAL_VALIDATOR_TYPES.has(validator.type));
}

function isScaffoldLikeStep(step: LockstepStep): boolean {
  return step.validate.every((validator) => SCAFFOLD_VALIDATOR_TYPES.has(validator.type));
}

function usesInstallRequiringValidators(step: LockstepStep): boolean {
  return step.validate.some((validator) => {
    if (!INSTALL_REQUIRING_VALIDATOR_TYPES.has(validator.type)) {
      return false;
    }

    if (validator.type !== 'command_passes') {
      return true;
    }

    const normalizedCommand = validator.command.trim();
    if (!normalizedCommand) {
      return false;
    }

    if (/^\s*node(?:\s+--input-type=\w+)?\s+-e\b/i.test(normalizedCommand)) {
      return false;
    }

    return /\b(?:pnpm|npm|yarn|bun|npx|corepack|tsc|eslint|prettier|vitest|jest|tsx|ts-node|turbo)\b/i.test(normalizedCommand)
      || normalizedCommand.includes('node_modules/.bin/');
  });
}

function getValidatorScopePath(validator: LockstepValidator): string | undefined {
  switch (validator.type) {
    case 'file_exists':
    case 'file_not_exists':
      return validator.target;
    case 'file_contains':
    case 'file_not_contains':
    case 'json_valid':
      return validator.path;
    default:
      return undefined;
  }
}

function getPackagePrefix(scopePath: string): string | undefined {
  const match = scopePath.match(/^packages\/([^/]+)/);
  return match ? `packages/${match[1]}` : undefined;
}

function humanizePackageLabel(packagePrefix: string): string {
  const segment = packagePrefix.split('/').at(-1) ?? packagePrefix;
  return segment.length <= 3
    ? segment.toUpperCase()
    : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
}

function summarizeScopedPaths(validators: LockstepValidator[], maxPaths = 6): string {
  const paths = Array.from(new Set(
    validators
      .filter((validator) => validator.type !== 'file_not_exists')
      .map((validator) => getValidatorScopePath(validator))
      .filter((path): path is string => typeof path === 'string'),
  ));

  if (paths.length === 0) {
    return 'the scoped files for this phase';
  }

  const listedPaths = paths.slice(0, maxPaths);
  const suffix = paths.length > maxPaths ? ', and the remaining scoped files for this phase' : '';
  return `${listedPaths.join(', ')}${suffix}`;
}

function buildScopedPrompt(scopeInstruction: string): string {
  return [
    scopeInstruction,
    '',
    'Shared scaffold rules:',
    '- This is one scoped phase of a production-grade TypeScript monorepo scaffold.',
    '- Keep the step install-free: only create or edit files. Do not run pnpm install, npm install, yarn install, bun install, npx, corepack, or any network-requiring command.',
    '- Use pnpm-workspace.yaml as the single source of truth for workspace membership.',
    '- When relevant, use package names @lockstep/api, @lockstep/sdk, @lockstep/runner, and @lockstep/shared.',
    '- Keep package exports aligned with dist/index.* via rootDir "./src" and outDir "./dist".',
    '- Use real placeholder tests at test/index.test.ts and do not compile tests into emitted runtime artifacts.',
  ].join('\n');
}

function buildSplitStep(
  original: LockstepStep,
  name: string,
  prompt: string,
  validate: LockstepValidator[],
  includeCommands = false,
): LockstepStep {
  return {
    name,
    prompt,
    ...(original.model ? { model: original.model } : {}),
    ...(original.timeout !== undefined ? { timeout: original.timeout } : {}),
    ...(original.retries !== undefined ? { retries: original.retries } : {}),
    ...(includeCommands && original.pre_commands ? { pre_commands: [...original.pre_commands] } : {}),
    ...(includeCommands && original.post_commands ? { post_commands: [...original.post_commands] } : {}),
    validate,
  };
}

function getScriptCommand(
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
  script: string,
): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

function buildCommandPassesValidator(command: string, timeout = 180): LockstepValidator {
  return {
    type: 'command_passes',
    command,
    timeout,
  } as LockstepValidator;
}

function buildFileExistsValidator(target: string): LockstepValidator {
  return {
    type: 'file_exists',
    target,
  } as LockstepValidator;
}

function getMonorepoScaffoldReviewValidators(
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
): LockstepValidator[] {
  const fileExistsValidators = [
    buildFileExistsValidator('vitest.config.ts'),
    ...(packageManager === 'pnpm' ? [buildFileExistsValidator('pnpm-lock.yaml')] : []),
  ];

  return [
    ...fileExistsValidators,
    ...['clean', 'format:check', 'lint', 'typecheck', 'build', 'test']
      .map((script) => buildCommandPassesValidator(getScriptCommand(packageManager, script))),
  ];
}

function isPackageManifestPlaceholderTestValidator(validator: LockstepValidator): boolean {
  return validator.type === 'file_contains'
    && validator.pattern === 'test/index.test.ts'
    && /^packages\/[^/]+\/package\.json$/u.test(validator.path);
}

function pruneMonorepoScaffoldValidators(validators: LockstepValidator[]): LockstepValidator[] {
  return validators.filter((validator) => !isPackageManifestPlaceholderTestValidator(validator));
}

function mergeUniqueValidators(
  validators: LockstepValidator[],
  additional: LockstepValidator[],
): LockstepValidator[] {
  const seenCommandPasses = new Set(
    validators
      .filter((validator): validator is Extract<LockstepValidator, { type: 'command_passes' }> => validator.type === 'command_passes')
      .map((validator) => validator.command),
  );

  return [
    ...validators,
    ...additional.filter((validator) => {
      if (validator.type !== 'command_passes') {
        return true;
      }
      if (seenCommandPasses.has(validator.command)) {
        return false;
      }
      seenCommandPasses.add(validator.command);
      return true;
    }),
  ];
}

function collectAiJudgeTargetPaths(validators: LockstepValidator[]): string[] {
  return Array.from(new Set(
    validators
      .map((validator) => {
        switch (validator.type) {
          case 'file_exists':
            return validator.target;
          case 'file_contains':
          case 'json_valid':
            return validator.path;
          default:
            return undefined;
        }
      })
      .filter((path): path is string =>
        typeof path === 'string'
        && path.length > 0,
      ),
  ));
}

function augmentAiJudgeEvaluationTargets(
  validators: LockstepValidator[],
  additionalTargets: string[],
): LockstepValidator[] {
  return validators.map((validator) => {
    if (validator.type !== 'ai_judge') {
      return validator;
    }

    const evaluationTargets = Array.from(new Set([
      ...(validator.evaluation_targets ?? []),
      ...additionalTargets,
    ]));

    return {
      ...validator,
      evaluation_targets: evaluationTargets,
    } satisfies LockstepValidator;
  });
}

const MONOREPO_REVIEW_AI_JUDGE_NOTE = [
  'Evaluate this as a workspace-coherence review using only the listed evaluation targets.',
  '- Root and package workflows should be explicit, internally consistent, and believable from a clean checkout.',
  '- If the root tsconfig is a project-reference graph, default root build, typecheck, and watch workflows should follow a solution-style path.',
  '- Keep the public root workflow surface minimal and coherent. Helper aliases may exist, but they should not introduce a second contradictory watch/test model.',
  '- If root tests prove built `dist` artifacts or published entrypoints, the root test and root watch-test scripts must make that build dependency explicit instead of assuming prior artifacts exist.',
  '- Dist artifacts should be self-contained. Do not penalize omitted map files unless the evaluated tsconfig or published contract explicitly chooses to emit them; if emitted entrypoints reference map files, those maps must exist and be included in the contract.',
  '- Package test scripts should stay credible from package directories and should not depend on cwd-sensitive root-relative path assumptions.',
  '- Package manifests, built/public entrypoints, emitted `dist/index.*` artifacts, and placeholder tests should prove the same published contract.',
  '- Shared cleanup helpers should be cross-platform and should refuse relative paths that escape the caller working directory.',
  '- A shared Vitest config pinned to the workspace root is valid and should be judged in that context.',
  '- For pnpm workspaces, a committed `pnpm-lock.yaml` is part of reproducible install quality and should stay structurally aligned even when the semantic review focuses on handwritten workspace files.',
].join('\n');

function augmentMonorepoReviewAiJudge(validators: LockstepValidator[]): LockstepValidator[] {
  return validators.map((validator) => {
    if (validator.type !== 'ai_judge') {
      return validator;
    }

    if (validator.criteria.includes('Evaluate this as a workspace-coherence review using only the listed evaluation targets.')) {
      return validator;
    }

    return {
      ...validator,
      criteria: `${validator.criteria.trimEnd()}\n\n${MONOREPO_REVIEW_AI_JUDGE_NOTE}`,
    } satisfies LockstepValidator;
  });
}

function buildMonorepoScaffoldReviewPrompt(): string {
  return [
    'Review the workspace scaffold created in earlier steps and fix any remaining cross-package inconsistencies only.',
    '- Focus on workspace membership, script coherence, tsconfig output boundaries, placeholder tests, and export/output alignment.',
    '- Run verification commands sequentially. Never background or parallelize build, lint, typecheck, test, or clean commands.',
    '- Prefer package-manager scripts or installed local binaries when verifying the workspace after dependencies are installed.',
    '- When the scaffold has both root and package Vitest suites, make the discovery contract explicit with a root vitest.config.ts that pins the workspace root and defines separate root/packages Vitest projects.',
    '- Keep root and package test workflows aligned. Root scripts should target the root Vitest project, and package scripts should either target dedicated package-scoped Vitest projects or use the shared packages project with package-local test paths instead of cwd-sensitive or shell-glob helpers.',
    '- Keep default watch/dev/test:watch entrypoints believable for the monorepo. If the root tsconfig is a project-reference graph, the default watch/dev loop should route through the root solution watcher; package-parallel watch helpers may exist, but only as explicit alternates.',
    '- Keep the public root workflow surface minimal. If helper aliases such as watch:packages or test:packages exist, they must stay explicit alternates and mirror the same package surfaces as the default workflows instead of introducing a second competing contract.',
    '- If the root tsconfig is a project-reference graph, keep root build, typecheck, and watch workflows solution-style and believable from a clean checkout.',
    '- If root tests assert built dist artifacts or published entrypoints, make the build dependency explicit in root test and root watch-test scripts instead of assuming a prebuilt workspace.',
    '- Keep emitted dist artifacts self-contained. Prefer sourceMap/declarationMap off for placeholder scaffolds unless those maps are intentionally part of the published contract and validation surface.',
    '- Keep type-aware lint and package typecheck believable from a clean checkout. Resolve workspace package imports through shared tsconfig paths when possible, and if a typecheck path requires the solution build graph, make that dependency explicit in the scripts instead of hiding it.',
    '- Keep build and typecheck meaningfully distinct, and make package script surfaces coherent for format, lint, test, typecheck, build, clean, and watch.',
    '- Package tests should be independently runnable under the shared Vitest workspace config and should prove the published package contract from a clean checkout. A mixed strategy is acceptable when it stays coherent: source-based behavior checks plus explicit built-entrypoint or emitted dist-output assertions.',
    '- Keep pnpm-lock.yaml committed and aligned with the workspace for reproducible installs.',
    '- Keep cross-platform clean workflows self-contained by providing any referenced helper script inside the workspace.',
    '- Any shared clean helper must refuse relative paths that escape the caller working directory.',
    '- Unless the task explicitly asks for a policy change, preserve strict compiler, lint, and test rules. Fix code or scripts instead of weakening the contract.',
    '- Do not add dependency-install commands to the prompt itself and do not add application logic in this phase.',
  ].join('\n');
}

function splitMonorepoScaffoldStep(
  step: LockstepStep,
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
): LockstepStep[] {
  if (!isScaffoldLikeStep(step)) {
    return [step];
  }

  const prunedValidators = pruneMonorepoScaffoldValidators(step.validate);
  const nonAiJudgeValidators = prunedValidators.filter((validator) => validator.type !== 'ai_judge');
  const packageOrder: string[] = [];
  const packageValidators = new Map<string, LockstepValidator[]>();
  const rootValidators: LockstepValidator[] = [];

  for (const validator of nonAiJudgeValidators) {
    const scopePath = getValidatorScopePath(validator);
    const packagePrefix = scopePath ? getPackagePrefix(scopePath) : undefined;
    if (!packagePrefix) {
      rootValidators.push(validator);
      continue;
    }

    if (!packageValidators.has(packagePrefix)) {
      packageValidators.set(packagePrefix, []);
      packageOrder.push(packagePrefix);
    }

    packageValidators.get(packagePrefix)?.push(validator);
  }

  if (packageOrder.length < 3 || rootValidators.length === 0 || nonAiJudgeValidators.length < 16) {
    return [step];
  }

  const splitSteps: LockstepStep[] = [
    buildSplitStep(
      step,
      'Root workspace scaffold',
      buildScopedPrompt(
        `Create ONLY the repository-root workspace scaffold in this step. Limit changes to root-level files such as ${summarizeScopedPaths(rootValidators)}. Do not create or edit files under packages/* yet, and keep this phase install-free.`,
      ),
      rootValidators,
    ),
  ];

  for (const packagePrefix of packageOrder) {
    const scopedValidators = packageValidators.get(packagePrefix) ?? [];
    splitSteps.push(
      buildSplitStep(
        step,
        `${humanizePackageLabel(packagePrefix)} package scaffold`,
        buildScopedPrompt(
          `Continue the scaffold by creating or updating ONLY the files under ${packagePrefix}/ in this step, specifically ${summarizeScopedPaths(scopedValidators)}. Do not modify sibling packages. Keep exports aligned with dist/index.* by using rootDir "./src" and outDir "./dist", keep placeholder tests at test/index.test.ts, and do not compile tests into emitted runtime artifacts.`,
        ),
        scopedValidators,
      ),
    );
  }

  if (prunedValidators.some((validator) => validator.type === 'ai_judge')) {
    const reviewValidators = augmentMonorepoReviewAiJudge(
      mergeUniqueValidators(
        prunedValidators,
        getMonorepoScaffoldReviewValidators(packageManager),
      ),
    );
    const reviewTargetPaths = collectAiJudgeTargetPaths(reviewValidators);
    splitSteps.push(
      buildSplitStep(
        step,
        `${step.name} review`,
        buildMonorepoScaffoldReviewPrompt(),
        augmentAiJudgeEvaluationTargets(reviewValidators, reviewTargetPaths),
        true,
      ),
    );
  }

  return splitSteps;
}

function hardenGeneratedSpec(spec: LockstepSpec): LockstepSpec {
  const packageManager = detectPackageManager(spec);
  const expandedSteps = spec.steps.flatMap((step) => splitMonorepoScaffoldStep(step, packageManager));

  return {
    ...spec,
    steps: expandedSteps.map((step) => {
      const nextStep = {
        ...step,
        pre_commands: step.pre_commands ? [...step.pre_commands] : undefined,
      };

      if (isScaffoldLikeStep(step)) {
        nextStep.prompt = appendPromptNote(step.prompt, SANDBOXED_SCAFFOLD_NOTE);
        if (packageManager === 'pnpm') {
          nextStep.prompt = appendPromptNote(nextStep.prompt, PNPM_MONOREPO_NOTE);
        }
      }

      if (usesInstallRequiringValidators(step) && !hasInstallPreCommand(step.pre_commands)) {
        nextStep.pre_commands = [getInstallCommand(packageManager), ...(nextStep.pre_commands ?? [])];
      }

      return nextStep;
    }),
  };
}

function validateSpecObject(candidate: unknown, specLabel: string): LockstepSpec {
  const result = LockstepSpecSchema.safeParse(canonicalizeSpecInput(candidate));
  if (!result.success) {
    throw new Error(formatSchemaIssues(specLabel, result.error.issues));
  }

  return hardenGeneratedSpec(normalizeSpecWorkingDirectoryPaths(result.data));
}

function parseEnvelopeOutput(raw: string): GeneratedSpec[] {
  let parsed: unknown;

  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Envelope YAML parse failed: ${describeError(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Envelope must be a YAML mapping with a top-level "specs" array');
  }

  const specs = (parsed as { specs?: unknown }).specs;
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('Envelope must include a non-empty "specs" array');
  }

  return specs.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`specs.${index} must be a mapping`);
    }

    const item = entry as { filename?: unknown; spec?: unknown };
    const filename = normalizeFilename(item.filename, index);
    const validated = validateSpecObject(item.spec, `specs.${index}.spec`);
    return toGeneratedSpec(validated, filename);
  });
}

function extractLegacyFilename(yamlContent: string): { filename?: string; content: string } {
  const filenameMatch = yamlContent.match(/^#\s*([^\n]*\.yml)\s*$/m);
  if (!filenameMatch) {
    return { content: yamlContent.trim() };
  }

  return {
    filename: filenameMatch[1].trim(),
    content: yamlContent.replace(/^#\s*[^\n]*\.yml\s*\n?/, '').trim(),
  };
}

function parseLegacyOutput(raw: string): GeneratedSpec[] {
  const parts = raw.includes('---SPLIT---')
    ? raw.split('---SPLIT---').map((part) => part.trim()).filter(Boolean)
    : [raw.trim()];

  if (parts.length === 0) {
    throw new Error('No YAML content returned');
  }

  return parts.map((part, index) => {
    const legacy = extractLegacyFilename(part);
    let parsed: unknown;

    try {
      parsed = yaml.load(legacy.content);
    } catch (err) {
      throw new Error(`Legacy spec ${index + 1} YAML parse failed: ${describeError(err)}`);
    }

    const validated = validateSpecObject(parsed, `spec ${index + 1}`);
    const filename = legacy.filename ?? normalizeFilename(undefined, index);
    return toGeneratedSpec(validated, filename);
  });
}

function parseGeneratedOutput(raw: string): GeneratedSpec[] {
  const cleaned = stripMarkdownFences(raw);
  if (!cleaned) {
    throw new Error('Codex returned empty output');
  }

  const errors: string[] = [];

  try {
    return parseEnvelopeOutput(cleaned);
  } catch (err) {
    errors.push(describeError(err));
  }

  try {
    return parseLegacyOutput(cleaned);
  } catch (err) {
    errors.push(describeError(err));
  }

  throw new Error(errors.join(' | '));
}

function buildRepairAttemptPrompt(
  promptText: string,
  invalidOutput: string,
  validationError: string,
): string {
  return `${REPAIR_PROMPT}

## Validation Errors (FIX THESE EXACTLY)

${validationError}

Each error is formatted as \`specs.N.spec.path: message\`. Focus on spec N and fix the exact path indicated.
For example, \`specs.6.spec.steps.4.validate.1.criteria: Required\` means spec index 6, step index 4, validator index 1 is missing its \`criteria\` field.

## Original User Requirements

${promptText}

## Previous Invalid Response (fix and return corrected version)

${invalidOutput}`;
}

function normalizeGenerateOptions(
  optionsOrCallbacks?: GenerateOptions | GenerateCallbacks,
): GenerateOptions {
  if (!optionsOrCallbacks) {
    return {};
  }

  if (
    'callbacks' in optionsOrCallbacks ||
    'timeoutMs' in optionsOrCallbacks ||
    'maxAttempts' in optionsOrCallbacks
  ) {
    return optionsOrCallbacks;
  }

  return { callbacks: optionsOrCallbacks as GenerateCallbacks };
}

// ---------------------------------------------------------------------------
// Generate spec(s) from a prompt
// ---------------------------------------------------------------------------

export async function generateSpecs(
  promptText: string,
  optionsOrCallbacks?: GenerateOptions | GenerateCallbacks,
): Promise<GenerateResult> {
  const options = normalizeGenerateOptions(optionsOrCallbacks);
  const callbacks = options.callbacks;
  callbacks?.onGenerating?.();

  const maxAttempts = getGenerateMaxAttempts(options.maxAttempts);
  const model = getGenerateModel(options.model);
  const reasoningEffort = getGenerateReasoningEffort(options.reasoningEffort);
  const generationPrompt = `${SYSTEM_PROMPT}\n\n---\n\n## User Requirements\n\n${promptText}`;

  let prompt = generationPrompt;
  let lastParseError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await runCodex(prompt, callbacks, options.timeoutMs, model, reasoningEffort);

    try {
      const specs = parseGeneratedOutput(raw);
      return {
        specs,
        multiFile: specs.length > 1,
      };
    } catch (err) {
      lastParseError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) {
        break;
      }

      callbacks?.onRetry?.({
        attempt: attempt + 1,
        maxAttempts,
        reason: lastParseError.message,
      });
      prompt = buildRepairAttemptPrompt(promptText, stripMarkdownFences(raw), lastParseError.message);
    }
  }

  throw new Error(
    `Codex produced invalid Lockstep YAML after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ${lastParseError?.message ?? 'unknown parse error'}`,
  );
}

// ---------------------------------------------------------------------------
// Run Codex CLI
// ---------------------------------------------------------------------------

async function runCodex(
  prompt: string,
  callbacks?: GenerateCallbacks,
  timeoutMs?: number,
  model?: string,
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '--cd', process.cwd(),
      '--model', model ?? getGenerateModel(),
      '-c', `model_reasoning_effort="${reasoningEffort ?? getGenerateReasoningEffort()}"`,
      '-',
    ];

    const proc = spawn(process.env.CODEX_BIN ?? 'codex', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    });

    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        forceKillTimer = setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      }, timeoutMs);
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      callbacks?.onOutput?.(text);
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (killed) {
        const secs = timeoutMs! >= 1000 ? `${(timeoutMs! / 1000).toFixed(0)}s` : `${timeoutMs}ms`;
        reject(new Error(`Codex timed out after ${secs} while generating specs`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const exitDetail = signal ? `signal ${signal}` : `code ${code}`;
        const errorText = stderr.trim() || stdout.trim();
        reject(new Error(`Codex exited with ${exitDetail}${errorText ? `: ${errorText}` : ''}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run Codex: ${err.message}`));
    });
  });
}
