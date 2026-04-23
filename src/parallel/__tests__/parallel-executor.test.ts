import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseCoordinatorOutput,
  validateDecomposition,
  buildCoordinatorPrompt,
} from '../coordinator.js';
import { parseArchitectOutput } from '../architect.js';
import {
  resolveExecutionOrder,
  buildWorkerPrompt,
} from '../worker-dispatcher.js';
import { detectWeave } from '../merge-engine.js';
import {
  validateCoordinatorQuality,
  validateArchitectQuality,
} from '../phase-validator.js';
import type { TaskDecomposition, SubTask, SharedContracts, ParallelConfig } from '../types.js';
import type { LanguageInfo } from '../language-detect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubTask(overrides: Partial<SubTask> & { id: string }): SubTask {
  return {
    name: overrides.id,
    prompt: `Do ${overrides.id}`,
    files: [],
    reads: [],
    depends_on: [],
    ...overrides,
  };
}

function makeDecomposition(
  subTasks: SubTask[],
  executionOrder: string[][],
  sharedFiles: string[] = [],
): TaskDecomposition {
  return {
    original_prompt: 'test prompt',
    sub_tasks: subTasks,
    shared_files: sharedFiles,
    execution_order: executionOrder,
  };
}

function makeContracts(): SharedContracts {
  return {
    contracts_content: 'export interface Foo { bar: string; }',
    style_guide: 'Use camelCase.',
    glue_points: [],
    language: 'typescript',
    contracts_file_extension: '.ts',
  };
}

function makeLanguage(): LanguageInfo {
  return {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    contracts_extension: '.ts',
    type_system: 'interfaces and type aliases',
    contracts_template: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coordinator', () => {
  it('parses valid JSON decomposition', () => {
    const raw = JSON.stringify({
      original_prompt: 'Build feature X',
      sub_tasks: [
        {
          id: 'task-1',
          name: 'Create module A',
          prompt: 'Implement module A',
          files: ['src/a.ts'],
          reads: ['src/types.ts'],
          depends_on: [],
        },
        {
          id: 'task-2',
          name: 'Create module B',
          prompt: 'Implement module B',
          files: ['src/b.ts'],
          reads: [],
          depends_on: ['task-1'],
        },
      ],
      shared_files: ['src/index.ts'],
      execution_order: [['task-1'], ['task-2']],
    });

    const result = parseCoordinatorOutput(raw);

    assert.equal(result.original_prompt, 'Build feature X');
    assert.equal(result.sub_tasks.length, 2);
    assert.equal(result.sub_tasks[0].id, 'task-1');
    assert.deepEqual(result.sub_tasks[0].files, ['src/a.ts']);
    assert.deepEqual(result.shared_files, ['src/index.ts']);
    assert.deepEqual(result.execution_order, [['task-1'], ['task-2']]);
  });

  it('rejects overlapping file ownership', () => {
    const decomposition = makeDecomposition(
      [
        makeSubTask({ id: 'task-1', files: ['src/shared.ts', 'src/a.ts'] }),
        makeSubTask({ id: 'task-2', files: ['src/shared.ts', 'src/b.ts'] }),
      ],
      [['task-1', 'task-2']],
    );

    const result = validateDecomposition(decomposition);

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((e) => e.includes('src/shared.ts')),
      'Error should mention the overlapping file',
    );
  });

  it('accepts clean decomposition', () => {
    const decomposition = makeDecomposition(
      [
        makeSubTask({ id: 'task-1', files: ['src/a.ts'] }),
        makeSubTask({ id: 'task-2', files: ['src/b.ts'] }),
      ],
      [['task-1', 'task-2']],
    );

    const result = validateDecomposition(decomposition);

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('buildCoordinatorPrompt includes decomposition hint', () => {
    const config: ParallelConfig = {
      enabled: true,
      max_concurrency: 5,
      decomposition_hint: 'split by module',
      symlink_directories: ['node_modules'],
    };

    const prompt = buildCoordinatorPrompt('Do stuff', '', config, makeLanguage());

    assert.ok(
      prompt.includes('split by module'),
      'Prompt should contain the decomposition hint',
    );
  });
});

describe('architect', () => {
  it('parses valid JSON contracts', () => {
    const raw = JSON.stringify({
      contracts_content: 'export interface Config { port: number; }',
      style_guide: 'PascalCase for types, camelCase for functions.',
      glue_points: [
        {
          description: 'Config flows from task-1 to task-2',
          source_task: 'task-1',
          target_task: 'task-2',
          connection_type: 'import',
        },
      ],
    });

    const result = parseArchitectOutput(raw);

    assert.equal(result.contracts_content, 'export interface Config { port: number; }');
    assert.equal(result.style_guide, 'PascalCase for types, camelCase for functions.');
    assert.equal(result.glue_points.length, 1);
    assert.equal(result.glue_points[0].source_task, 'task-1');
    assert.equal(result.glue_points[0].connection_type, 'import');
  });
});

describe('worker-dispatcher', () => {
  it('resolveExecutionOrder groups tasks correctly', () => {
    const t1 = makeSubTask({ id: 'T1', files: ['a.ts'] });
    const t2 = makeSubTask({ id: 'T2', files: ['b.ts'] });
    const t3 = makeSubTask({ id: 'T3', files: ['c.ts'] });
    const t4 = makeSubTask({ id: 'T4', files: ['d.ts'] });

    const decomposition = makeDecomposition(
      [t1, t2, t3, t4],
      [['T1'], ['T2', 'T3'], ['T4']],
    );

    const groups = resolveExecutionOrder(decomposition);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].length, 1);
    assert.equal(groups[0][0].id, 'T1');
    assert.equal(groups[1].length, 2);
    assert.ok(groups[1].some((t) => t.id === 'T2'));
    assert.ok(groups[1].some((t) => t.id === 'T3'));
    assert.equal(groups[2].length, 1);
    assert.equal(groups[2][0].id, 'T4');
  });

  it('buildWorkerPrompt includes file ownership', () => {
    const subTask = makeSubTask({
      id: 'task-1',
      name: 'Build foo',
      files: ['src/foo.ts', 'src/bar.ts'],
    });

    const prompt = buildWorkerPrompt(subTask, makeContracts(), [], makeLanguage());

    assert.ok(prompt.includes('src/foo.ts'), 'Prompt should mention src/foo.ts');
    assert.ok(prompt.includes('src/bar.ts'), 'Prompt should mention src/bar.ts');
    assert.ok(
      prompt.includes('File Ownership') || prompt.includes('file') || prompt.includes('MUST only'),
      'Prompt should mention file ownership boundaries',
    );
  });
});

describe('phase-validator', () => {
  it('warns on single-task decomposition', () => {
    const decomposition = makeDecomposition(
      [makeSubTask({ id: 'task-1', files: ['src/a.ts'], prompt: 'Implement the entire feature' })],
      [['task-1']],
    );

    const result = validateCoordinatorQuality(decomposition);

    assert.equal(result.valid, true);
    assert.ok(
      result.warnings.some((w) => w.includes('Single sub-task')),
      'Should warn about single sub-task',
    );
  });

  it('warns on short prompts', () => {
    const decomposition = makeDecomposition(
      [
        makeSubTask({ id: 'task-1', files: ['a.ts'], prompt: 'Do X' }),
        makeSubTask({ id: 'task-2', files: ['b.ts'], prompt: 'A sufficiently long prompt for a real task' }),
      ],
      [['task-1', 'task-2']],
    );

    const result = validateCoordinatorQuality(decomposition);

    assert.equal(result.valid, true);
    assert.ok(
      result.warnings.some((w) => w.includes('task-1') && w.includes('short prompt')),
      'Should warn about short prompt',
    );
  });

  it('detects circular dependencies', () => {
    const decomposition = makeDecomposition(
      [
        makeSubTask({ id: 'task-1', files: ['a.ts'], depends_on: ['task-2'], prompt: 'Implement module A that depends on B' }),
        makeSubTask({ id: 'task-2', files: ['b.ts'], depends_on: ['task-1'], prompt: 'Implement module B that depends on A' }),
      ],
      [['task-1', 'task-2']],
    );

    const result = validateCoordinatorQuality(decomposition);

    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('Circular dependency')),
      'Should detect circular dependency',
    );
  });

  it('validates glue points reference valid task IDs', async () => {
    const decomposition = makeDecomposition(
      [
        makeSubTask({ id: 'task-1', files: ['a.ts'], prompt: 'Implement module A with exports' }),
        makeSubTask({ id: 'task-2', files: ['b.ts'], prompt: 'Implement module B with imports' }),
      ],
      [['task-1', 'task-2']],
    );

    const contracts: SharedContracts = {
      contracts_content: 'export interface Foo { bar: string; }',
      style_guide: 'Use camelCase.',
      glue_points: [
        {
          description: 'Foo flows from task-1 to nonexistent',
          source_task: 'task-1',
          target_task: 'task-999',
          connection_type: 'import',
        },
      ],
      language: 'typescript',
      contracts_file_extension: '.ts',
    };

    const result = await validateArchitectQuality(contracts, decomposition, makeLanguage());

    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('task-999')),
      'Should flag invalid target_task',
    );
  });

  it('validates TypeScript contracts syntax', async () => {
    const decomposition = makeDecomposition(
      [makeSubTask({ id: 'task-1', files: ['a.ts'], prompt: 'Implement module A' })],
      [['task-1']],
    );

    const contracts: SharedContracts = {
      contracts_content: 'export interface Foo { bar: string; }',
      style_guide: 'Use camelCase.',
      glue_points: [],
      language: 'typescript',
      contracts_file_extension: '.ts',
    };

    const result = await validateArchitectQuality(contracts, decomposition, makeLanguage());
    assert.equal(result.valid, true);
  });

  it('rejects invalid TypeScript contracts syntax', async () => {
    const decomposition = makeDecomposition(
      [makeSubTask({ id: 'task-1', files: ['a.ts'], prompt: 'Implement module A' })],
      [['task-1']],
    );

    const contracts: SharedContracts = {
      contracts_content: 'export interface Foo { bar: string; ===INVALID===',
      style_guide: 'Use camelCase.',
      glue_points: [],
      language: 'typescript',
      contracts_file_extension: '.ts',
    };

    const result = await validateArchitectQuality(contracts, decomposition, makeLanguage());
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('syntax')),
      'Should report syntax error',
    );
  });
});

describe('merge-engine', () => {
  it('detectWeave finds installed weave-driver', async () => {
    const result = await detectWeave();

    // weave-driver is installed via cargo; if not in CI, it should be available
    if (result.available) {
      assert.ok(result.binary_path.length > 0, 'binary_path should be non-empty');
      assert.ok(result.supported_extensions.length > 0, 'should list supported extensions');
      assert.ok(
        result.supported_extensions.includes('.ts'),
        'should include .ts extension',
      );
    } else {
      // In environments without weave-driver, this is acceptable
      assert.equal(result.binary_path, '');
      assert.deepEqual(result.supported_extensions, []);
    }
  });
});
