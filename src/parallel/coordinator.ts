import { createAgent } from '../agents/factory.js';
import {
  PARALLEL_MODELS,
  type ParallelConfig,
  type TaskDecomposition,
  type CoordinatorResult,
  type RepoMap,
} from './types.js';
import type { LanguageInfo } from './language-detect.js';
import { generateRepoMap, formatRepoMap } from './repo-map.js';
import { getEntityOwnershipPromptSection, validateEntityClaims } from './entity-ownership.js';
import { resolveParallelRoleModel } from './model-selection.js';
import { sanitizeTaskId } from '../utils/path-security.js';

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildCoordinatorPrompt(
  stepPrompt: string,
  context: string,
  config: ParallelConfig,
  language: LanguageInfo,
  repoMap?: RepoMap,
): string {
  const parts: string[] = [];

  parts.push(
    'You are a task decomposition coordinator for a parallel execution pipeline.',
    'Your job is to analyze a development task and break it into independent sub-tasks',
    'that can be executed in parallel by separate AI agents, each in its own git worktree.',
    '',
    `The project is written in ${language.name}. Files will have ${language.extensions.join(', ')} extensions.`,
    '',
    '## Rules',
    '',
    '1. Each sub-task MUST have a unique `id` (e.g. "task-1", "task-2").',
    '2. Each sub-task MUST list the files it OWNS in `files`. These are the files it will create or modify.',
    '3. CRITICAL: NO two sub-tasks may share files in their `files` array. File ownership is exclusive.',
    '4. Each sub-task MAY list files it needs to READ (but not modify) in `reads`.',
    '5. If a sub-task depends on another completing first, list the dependency in `depends_on`.',
    '6. Files that multiple workers need to modify (e.g. index.ts, package.json, config files)',
    '   MUST go in `shared_files` — no worker touches these; a later Integrator phase handles them.',
    '7. `execution_order` is an array of arrays — each inner array is a group of task IDs',
    '   that can run in parallel. Groups execute sequentially (group 0 first, then group 1, etc.).',
    '8. If the task is simple or atomic, output a SINGLE sub-task (N=1). Do not over-decompose.',
    `9. Maximum concurrency is ${config.max_concurrency} — do not create more parallel tasks than this.`,
    '',
  );

  if (config.decomposition_hint) {
    parts.push(
      '## Decomposition Hint',
      '',
      config.decomposition_hint,
      '',
    );
  }

  if (repoMap && repoMap.entries.length > 0) {
    parts.push(
      '## Repository Structure (AST Map)',
      '',
      'The following is a compact map of the project\'s declarations, exports, and imports.',
      'Use this to understand the codebase structure and assign files to tasks accurately.',
      '',
      '```',
      formatRepoMap(repoMap.entries),
      '```',
      '',
    );
  }

  if (config.entity_ownership) {
    parts.push(getEntityOwnershipPromptSection());
  }

  if (context) {
    parts.push(
      '## Project Context',
      '',
      context,
      '',
    );
  }

  parts.push(
    '## Task to Decompose',
    '',
    stepPrompt,
    '',
    '## Output Format',
    '',
    'Output ONLY valid JSON matching this exact structure (no markdown, no explanation, no extra text):',
    '',
    '{',
    '  "original_prompt": "<the full task prompt>",',
    '  "sub_tasks": [',
    '    {',
    '      "id": "task-1",',
    '      "name": "Human-readable name",',
    '      "prompt": "Detailed prompt for this sub-task",',
    '      "files": ["src/foo.ts", "src/bar.ts"],',
    '      "reads": ["src/types.ts"],',
    '      "depends_on": []',
    ...(config.entity_ownership ? [
    '      ,"entities": [{"file": "src/shared.ts", "entity_name": "myFunc", "entity_type": "function"}]',
    ] : []),
    '    }',
    '  ],',
    '  "shared_files": ["src/index.ts"],',
    '  "execution_order": [["task-1", "task-2"], ["task-3"]]',
    '}',
    '',
    'Output ONLY the JSON object. No markdown code fences. No explanation before or after.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

export function parseCoordinatorOutput(output: string): TaskDecomposition {
  let jsonStr = output.trim();

  // Try direct parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback 1: extract JSON object by finding outermost { ... }
    // (Do this BEFORE fence stripping — fence regex matches backticks inside JSON strings)
    const objectStart = jsonStr.indexOf('{');
    const objectEnd = jsonStr.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
      try {
        parsed = JSON.parse(jsonStr.slice(objectStart, objectEnd + 1));
      } catch {
        // Fallback 2: strip markdown code fences (for output wrapped in ```)
        const fencedMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fencedMatch) {
          jsonStr = fencedMatch[1].trim();
        }
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          throw new Error(
            `Failed to parse coordinator output as JSON.\nRaw output:\n${output.slice(0, 500)}`,
          );
        }
      }
    } else {
      throw new Error(
        `Failed to parse coordinator output as JSON.\nRaw output:\n${output.slice(0, 500)}`,
      );
    }
  }

  // Validate structure
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.original_prompt !== 'string') {
    throw new Error('Coordinator output missing or invalid "original_prompt" field');
  }
  if (!Array.isArray(obj.sub_tasks) || obj.sub_tasks.length === 0) {
    throw new Error('Coordinator output missing or empty "sub_tasks" array');
  }
  if (!Array.isArray(obj.shared_files)) {
    throw new Error('Coordinator output missing "shared_files" array');
  }
  if (!Array.isArray(obj.execution_order)) {
    throw new Error('Coordinator output missing "execution_order" array');
  }

  for (let i = 0; i < obj.sub_tasks.length; i++) {
    const task = obj.sub_tasks[i] as Record<string, unknown>;
    const prefix = `sub_tasks[${i}]`;

    if (typeof task.id !== 'string' || task.id.length === 0) {
      throw new Error(`${prefix} missing or invalid "id"`);
    }
    if (typeof task.name !== 'string' || task.name.length === 0) {
      throw new Error(`${prefix} missing or invalid "name"`);
    }
    if (typeof task.prompt !== 'string' || task.prompt.length === 0) {
      throw new Error(`${prefix} missing or invalid "prompt"`);
    }
    if (!Array.isArray(task.files)) {
      throw new Error(`${prefix} missing "files" array`);
    }
    if (!Array.isArray(task.reads)) {
      throw new Error(`${prefix} missing "reads" array`);
    }
    if (!Array.isArray(task.depends_on)) {
      throw new Error(`${prefix} missing "depends_on" array`);
    }
  }

  const decomposition = parsed as TaskDecomposition;
  const idMap = new Map<string, string>();
  const seenTaskIds = new Set<string>();

  decomposition.sub_tasks = decomposition.sub_tasks.map((task, index) => {
    const fallback = `task-${index + 1}`;
    const sanitizedId = sanitizeTaskId(task.id, fallback);

    if (seenTaskIds.has(sanitizedId)) {
      throw new Error(`Coordinator produced duplicate task id after sanitization: "${sanitizedId}"`);
    }

    seenTaskIds.add(sanitizedId);
    idMap.set(task.id, sanitizedId);

    return {
      ...task,
      id: sanitizedId,
    };
  });

  decomposition.sub_tasks = decomposition.sub_tasks.map((task) => ({
    ...task,
    depends_on: task.depends_on.map((dep) => idMap.get(dep) ?? sanitizeTaskId(dep)),
  }));
  decomposition.execution_order = decomposition.execution_order.map((group) =>
    group.map((taskId) => idMap.get(taskId) ?? sanitizeTaskId(taskId)),
  );

  return decomposition;
}

// ---------------------------------------------------------------------------
// Decomposition validator
// ---------------------------------------------------------------------------

export function validateDecomposition(
  decomposition: TaskDecomposition,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const taskIds = new Set(decomposition.sub_tasks.map((t) => t.id));

  if (taskIds.size !== decomposition.sub_tasks.length) {
    errors.push('Sub-task IDs must be unique');
  }

  // Check for duplicate file ownership across sub-tasks
  const fileOwnership = new Map<string, string>();
  for (const task of decomposition.sub_tasks) {
    for (const file of task.files) {
      const existingOwner = fileOwnership.get(file);
      if (existingOwner) {
        errors.push(
          `File "${file}" is claimed by both "${existingOwner}" and "${task.id}"`,
        );
      } else {
        fileOwnership.set(file, task.id);
      }
    }
  }

  // Check that all depends_on references are valid
  for (const task of decomposition.sub_tasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        errors.push(
          `Task "${task.id}" depends on "${dep}" which does not exist`,
        );
      }
      if (dep === task.id) {
        errors.push(`Task "${task.id}" depends on itself`);
      }
    }
  }

  // Check that execution_order contains all task IDs
  const orderedIds = new Set(decomposition.execution_order.flat());
  const taskIdArray = Array.from(taskIds);
  const orderedIdArray = Array.from(orderedIds);
  for (const id of taskIdArray) {
    if (!orderedIds.has(id)) {
      errors.push(`Task "${id}" is missing from execution_order`);
    }
  }
  for (const id of orderedIdArray) {
    if (!taskIds.has(id)) {
      errors.push(
        `execution_order references "${id}" which is not a valid sub-task`,
      );
    }
  }

  // Check that shared_files don't overlap with any sub-task's files
  const sharedSet = new Set(decomposition.shared_files);
  for (const task of decomposition.sub_tasks) {
    for (const file of task.files) {
      if (sharedSet.has(file)) {
        errors.push(
          `File "${file}" is in shared_files but also owned by task "${task.id}"`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runCoordinator(
  stepPrompt: string,
  context: string,
  config: ParallelConfig,
  workingDirectory: string,
  timeout: number,
  language: LanguageInfo,
  repoMap?: RepoMap,
): Promise<CoordinatorResult> {
  // Generate repo map if enabled and not provided
  let effectiveRepoMap = repoMap;
  if (config.repo_map && !effectiveRepoMap) {
    try {
      effectiveRepoMap = await generateRepoMap(workingDirectory, language);
    } catch {
      // Repo map generation failed — proceed without it
    }
  }

  const agent = createAgent(config.agent);
  const prompt = buildCoordinatorPrompt(stepPrompt, context, config, language, effectiveRepoMap);

  const startTime = Date.now();

  const result = await agent.execute(prompt, {
    workingDirectory,
    timeout,
    model: resolveParallelRoleModel(config.agent, PARALLEL_MODELS.coordinator, config.agent_model),
  });

  const duration = Date.now() - startTime;

  if (!result.success) {
    throw new Error(
      `Coordinator agent failed (exit code ${result.exitCode}):\n${result.stderr}`,
    );
  }

  const decomposition = parseCoordinatorOutput(result.stdout);
  const validation = validateDecomposition(decomposition);

  if (!validation.valid) {
    throw new Error(
      `Coordinator produced invalid decomposition:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  // Validate entity-level claims if any tasks use them
  if (config.entity_ownership) {
    const entityErrors = validateEntityClaims(decomposition.sub_tasks);
    if (entityErrors.length > 0) {
      throw new Error(
        `Entity ownership conflicts:\n${entityErrors.map((e) => `  - ${e}`).join('\n')}`,
      );
    }
  }

  return {
    decomposition,
    raw_output: result.stdout,
    duration,
  };
}
