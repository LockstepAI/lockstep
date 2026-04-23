import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class MockProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: vi.fn(() => true),
    end: vi.fn(),
  };
  kill = vi.fn((signal?: NodeJS.Signals) => {
    queueMicrotask(() => {
      this.emit('close', null, signal ?? 'SIGTERM');
    });
    return true;
  });
}

function completedProcess({
  stdout = '',
  stderr = '',
  code = 0,
}: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): MockProcess {
  const proc = new MockProcess();

  queueMicrotask(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    proc.emit('close', code, null);
  });

  return proc;
}

function spawnCompletedProcess(result: {
  stdout?: string;
  stderr?: string;
  code?: number;
}) {
  return () => completedProcess(result);
}

function hangingProcess(): MockProcess {
  return new MockProcess();
}

async function loadGenerator() {
  vi.resetModules();
  return import('../src/generators/spec-generator.js');
}

describe('spec generator', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env.LOCKSTEP_GENERATE_TIMEOUT_MS;
    delete process.env.LOCKSTEP_GENERATE_MAX_ATTEMPTS;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries invalid generated output and repairs it into a valid spec', async () => {
    const invalidSpec = `
version: "1"
steps:
  - name: Missing validators
    prompt: |
      This is missing validate rules.
`;

    const repairedSpec = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      steps:
        - name: Build foundation
          prompt: |
            Create the project structure.
          validate:
            - type: file_exists
              target: package.json
`;

    spawnMock
      .mockImplementationOnce(spawnCompletedProcess({ stdout: invalidSpec }))
      .mockImplementationOnce(spawnCompletedProcess({ stdout: repairedSpec }));

    const { generateSpecs } = await loadGenerator();
    const onRetry = vi.fn();

    const result = await generateSpecs('Create the initial project setup.', {
      timeoutMs: 1_000,
      maxAttempts: 2,
      callbacks: { onRetry },
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(result.multiFile).toBe(false);
    expect(result.specs[0]).toMatchObject({
      filename: '.lockstep.yml',
      stepCount: 1,
      stepNames: ['Build foundation'],
    });

    const repairProc = spawnMock.mock.results[1]?.value as MockProcess | undefined;
    expect(repairProc).toBeDefined();
    expect(String(repairProc?.stdin.write.mock.calls[0][0])).toContain('## Previous Invalid Response');
  });

  it('accepts the legacy split format for backward compatibility', async () => {
    const legacyResponse = `
# lockstep-01-foundation.yml
version: "1"
steps:
  - name: Foundation
    prompt: "Set up the repo"
    validate:
      - type: file_exists
        target: package.json
---SPLIT---
# lockstep-02-feature.yml
version: "1"
steps:
  - name: Feature
    prompt: "Implement the main feature"
    validate:
      - type: command_passes
        command: npm test
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: legacyResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Build the repo and then add the feature.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.multiFile).toBe(true);
    expect(result.specs.map((spec) => spec.filename)).toEqual([
      'lockstep-01-foundation.yml',
      'lockstep-02-feature.yml',
    ]);
    expect(result.specs.map((spec) => spec.stepNames)).toEqual([
      ['Foundation'],
      ['Feature'],
    ]);
  });

  it('normalizes generated validator paths relative to the working directory', async () => {
    const generatedResponse = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      config:
        working_directory: github-action
      steps:
        - name: Update AI handling
          prompt: "Fix the action package"
          validate:
            - type: file_contains
              path: github-action/src/index.ts
              pattern: ai_judge
            - type: file_exists
              target: github-action/action.yml
            - type: ai_judge
              criteria: Review the patch
              threshold: 8
              evaluation_targets:
                - github-action/src/index.ts
                - github-action/README.md
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: generatedResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Harden the GitHub Action runtime.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].content).toContain('working_directory: github-action');
    expect(result.specs[0].content).toContain('path: src/index.ts');
    expect(result.specs[0].content).toContain('target: action.yml');
    expect(result.specs[0].content).toContain('- src/index.ts');
    expect(result.specs[0].content).toContain('- README.md');
    expect(result.specs[0].content).not.toContain('github-action/src/index.ts');
    expect(result.specs[0].content).not.toContain('github-action/action.yml');
  });

  it('hardens scaffold prompts and injects host-side installs for later runtime validators', async () => {
    const generatedResponse = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      steps:
        - name: Foundation
          prompt: |
            Create the workspace scaffold.
          validate:
            - type: file_exists
              target: package.json
            - type: file_exists
              target: pnpm-workspace.yaml
        - name: Shared
          prompt: |
            Implement the shared package and make its tests pass.
          validate:
            - type: command_passes
              command: pnpm --filter @lockstep/shared test
            - type: file_exists
              target: packages/shared/src/index.ts
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: generatedResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Create a pnpm workspace with a shared package.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].content).toContain('Do not run `pnpm install`, `npm install`, `yarn install`, `bun install`, `npx`, `corepack`');
    expect(result.specs[0].content).toContain('pre_commands:');
    expect(result.specs[0].content).toContain('- pnpm install');
  });

  it('splits oversized monorepo scaffold steps into root, package, and review phases', async () => {
    const generatedResponse = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      steps:
        - name: Workspace scaffold
          prompt: |
            Create the root workspace scaffold and all package skeletons.
          validate:
            - type: file_exists
              target: package.json
            - type: file_exists
              target: pnpm-workspace.yaml
            - type: file_exists
              target: tsconfig.base.json
            - type: file_exists
              target: tsconfig.json
            - type: file_exists
              target: scripts/clean.mjs
            - type: file_exists
              target: packages/api/package.json
            - type: file_exists
              target: packages/api/tsconfig.json
            - type: file_exists
              target: packages/api/src/index.ts
            - type: file_exists
              target: packages/sdk/package.json
            - type: file_exists
              target: packages/sdk/tsconfig.json
            - type: file_exists
              target: packages/sdk/src/index.ts
            - type: file_exists
              target: packages/runner/package.json
            - type: file_exists
              target: packages/runner/tsconfig.json
            - type: file_exists
              target: packages/runner/src/index.ts
            - type: file_exists
              target: packages/shared/package.json
            - type: file_exists
              target: packages/shared/tsconfig.json
            - type: file_exists
              target: packages/shared/src/index.ts
            - type: ai_judge
              criteria: Review the workspace scaffold.
              threshold: 8
              evaluation_targets:
                - package.json
                - pnpm-workspace.yaml
                - packages/api/package.json
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: generatedResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Create a strict pnpm monorepo with api, sdk, runner, and shared packages.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].stepNames).toEqual([
      'Root workspace scaffold',
      'API package scaffold',
      'SDK package scaffold',
      'Runner package scaffold',
      'Shared package scaffold',
      'Workspace scaffold review',
    ]);
    expect(result.specs[0].content).toContain('Do not create or edit files under packages/* yet');
    expect(result.specs[0].content).toContain('Continue the scaffold by creating or updating ONLY the files under packages/api/');
    expect(result.specs[0].content).toContain('Run verification commands sequentially');
    expect(result.specs[0].content).toContain('root vitest.config.ts');
    expect(result.specs[0].content).toContain('separate `root` and `packages` Vitest projects');
    expect(result.specs[0].content).toContain('package scripts should either target dedicated package-scoped Vitest projects or use the shared packages project with package-local test paths');
    expect(result.specs[0].content).toContain('default watch/dev loop should route through the root solution watcher');
    expect(result.specs[0].content).toContain('public root workflow surface minimal');
    expect(result.specs[0].content).toContain('prove the published package contract from a clean checkout');
    expect(result.specs[0].content).toContain('source-based behavior checks plus explicit built-entrypoint or emitted `dist/index.*` assertions');
    expect(result.specs[0].content).toContain('root build, typecheck, and watch workflows solution-style');
    expect(result.specs[0].content).toContain('make the build dependency explicit in root test and root watch-test scripts');
    expect(result.specs[0].content).toContain('Prefer sourceMap/declarationMap off for placeholder scaffolds');
    expect(result.specs[0].content).toContain('Keep type-aware lint and package typecheck believable from a clean checkout');
    expect(result.specs[0].content).toContain('Root clean workflows should remove incremental build artifacts for the root config surfaces they own');
    expect(result.specs[0].content).toContain('refuse relative paths that escape the caller working directory');
    expect(result.specs[0].content).toContain('preserve strict compiler, lint, and test rules');
    expect(result.specs[0].content).toContain('target: vitest.config.ts');
    expect(result.specs[0].content).toContain('target: pnpm-lock.yaml');
    expect(result.specs[0].content).toContain('command: pnpm clean');
    expect(result.specs[0].content).toContain('command: pnpm lint');
    expect(result.specs[0].content).toContain('command: pnpm format:check');
    expect(result.specs[0].content).toContain('command: pnpm typecheck');
    expect(result.specs[0].content).toContain('command: pnpm build');
    expect(result.specs[0].content).toContain('command: pnpm test');
    expect(result.specs[0].content).toContain('- scripts/clean.mjs');
    expect(result.specs[0].content).toContain('- vitest.config.ts');
    expect(result.specs[0].content).toMatch(/target: pnpm-lock\.yaml/);
    expect(result.specs[0].content).toMatch(/evaluation_targets:[\s\S]*- pnpm-lock\.yaml/);
    expect(result.specs[0].content).not.toContain('path: packages/api/package.json\n        pattern: test/index.test.ts');
    expect(result.specs[0].content).not.toContain('path: packages/sdk/package.json\n        pattern: test/index.test.ts');
    expect(result.specs[0].content).not.toContain('path: packages/runner/package.json\n        pattern: test/index.test.ts');
    expect(result.specs[0].content).not.toContain('path: packages/shared/package.json\n        pattern: test/index.test.ts');
    expect(result.specs[0].content).toContain('pre_commands:');
    expect(result.specs[0].content).toContain('- pnpm install');
  });

  it('does not inject install pre_commands for scaffold reviews that only use ai_judge and structural validators', async () => {
    const generatedResponse = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      steps:
        - name: Scaffold review
          prompt: |
            Review the scaffold.
          validate:
            - type: file_exists
              target: package.json
            - type: ai_judge
              criteria: Review the scaffold.
              threshold: 8
              evaluation_targets:
                - package.json
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: generatedResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Review a scaffold-only workspace phase.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].content).not.toContain('pre_commands:');
    expect(result.specs[0].content).not.toContain('\n    - pnpm install');
    expect(result.specs[0].content).toContain('Do not run `pnpm install`, `npm install`, `yarn install`, `bun install`, `npx`, `corepack`');
  });

  it('does not inject install pre_commands for node-only verification commands', async () => {
    const generatedResponse = `
specs:
  - filename: ".lockstep.yml"
    spec:
      version: "1"
      steps:
        - name: Verify recap
          prompt: |
            Review the recap artifacts and fix them if needed.
          validate:
            - type: command_passes
              command: >
                node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('reports/live-run.json','utf8'));"
            - type: ai_judge
              criteria: Review the recap.
              threshold: 8
              evaluation_targets:
                - docs/launch-recap.md
                - reports/live-run.json
`;

    spawnMock.mockImplementationOnce(spawnCompletedProcess({ stdout: generatedResponse }));

    const { generateSpecs } = await loadGenerator();
    const result = await generateSpecs('Review docs and a JSON report in a scratch workspace.', {
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].content).not.toContain('pre_commands:');
    expect(result.specs[0].content).not.toContain('\n    - pnpm install');
    expect(result.specs[0].content).toContain("node -e \"const fs=require('fs');");
    expect(result.specs[0].content).not.toContain('For pnpm monorepos');
    expect(result.specs[0].content).not.toContain('pnpm-workspace.yaml');
  });

  it('times out long-running Codex processes with a clear error and clears the force-kill timer', async () => {
    vi.useFakeTimers();

    const proc = hangingProcess();
    spawnMock.mockImplementationOnce(() => proc);

    const { generateSpecs } = await loadGenerator();
    const generation = generateSpecs('A very long prompt', {
      timeoutMs: 10,
      maxAttempts: 1,
    });
    const rejection = expect(generation).rejects.toThrow(
      'Codex timed out after 10ms while generating specs',
    );

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});
