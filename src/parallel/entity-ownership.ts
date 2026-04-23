import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SubTask, WorkerResult } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Entity-level ownership validation
// ---------------------------------------------------------------------------

/**
 * Validates that entity claims across all sub-tasks do not conflict.
 * Two tasks cannot claim the same entity (function/class/method) in the same file.
 * Returns a list of conflict descriptions, empty if valid.
 */
export function validateEntityClaims(tasks: SubTask[]): string[] {
  const errors: string[] = [];

  // Build a map of file:entity → task_id
  const claimMap = new Map<string, string>();

  for (const task of tasks) {
    if (!task.entities) continue;

    for (const entity of task.entities) {
      const key = `${entity.file}::${entity.entity_name}`;
      const existingOwner = claimMap.get(key);

      if (existingOwner) {
        errors.push(
          `Entity "${entity.entity_name}" in ${entity.file} claimed by both "${existingOwner}" and "${task.id}"`,
        );
      } else {
        claimMap.set(key, task.id);
      }
    }
  }

  return errors;
}

/**
 * Builds a map of file → entity_name[] for a specific task.
 * Used to check which entities a worker is allowed to modify in shared files.
 */
export function getEntityOwnershipMap(task: SubTask): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();

  if (!task.entities) return map;

  for (const entity of task.entities) {
    let set = map.get(entity.file);
    if (!set) {
      set = new Set();
      map.set(entity.file, set);
    }
    set.add(entity.entity_name);
  }

  return map;
}

/**
 * Checks whether a worker's changes to a shared file are limited to its
 * claimed entities. Uses git diff to inspect actual modifications.
 *
 * Returns a list of violations (entity names modified without ownership).
 */
export async function enforceEntityOwnership(
  workerResult: WorkerResult,
  task: SubTask,
  sharedFiles: string[],
): Promise<EntityViolation[]> {
  const violations: EntityViolation[] = [];
  const entityMap = getEntityOwnershipMap(task);

  if (entityMap.size === 0) return violations;

  const sharedSet = new Set(sharedFiles);

  for (const file of workerResult.files_modified) {
    // Only check shared files that have entity claims
    if (!sharedSet.has(file)) continue;
    const allowedEntities = entityMap.get(file);
    if (!allowedEntities) {
      // Worker modified a shared file without any entity claims
      violations.push({
        file,
        task_id: task.id,
        entities_modified: [],
        entities_allowed: [],
        description: `Modified shared file "${file}" without any entity claims`,
      });
      continue;
    }

    // Get the diff for this specific file
    try {
      const { stdout: diff } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--', file],
        { cwd: workerResult.worktree_path },
      );

      // Extract function/class names from the diff hunks
      const modifiedEntities = extractModifiedEntities(diff);
      const unauthorized = modifiedEntities.filter((e) => !allowedEntities.has(e));

      if (unauthorized.length > 0) {
        violations.push({
          file,
          task_id: task.id,
          entities_modified: unauthorized,
          entities_allowed: Array.from(allowedEntities),
          description: `Modified entities [${unauthorized.join(', ')}] without ownership (allowed: [${Array.from(allowedEntities).join(', ')}])`,
        });
      }
    } catch {
      // Can't get diff — skip this file
    }
  }

  return violations;
}

export interface EntityViolation {
  file: string;
  task_id: string;
  entities_modified: string[];
  entities_allowed: string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Diff entity extraction
// ---------------------------------------------------------------------------

/**
 * Extracts entity names (functions, classes, methods) from a git diff output.
 * Looks at the @@ hunk headers and actual changed lines to determine which
 * entities were modified.
 */
function extractModifiedEntities(diff: string): string[] {
  const entities = new Set<string>();
  const lines = diff.split('\n');

  for (const line of lines) {
    // Git diff hunk headers contain the function/class context:
    // @@ -10,5 +10,8 @@ function myFunction(
    const hunkMatch = line.match(/^@@[^@]+@@\s*(.+)/);
    if (hunkMatch) {
      const context = hunkMatch[1];
      // Extract function/class/method names from context
      const entityNames = extractEntityNamesFromContext(context);
      for (const name of entityNames) {
        entities.add(name);
      }
    }

    // Also check added/removed lines for entity definitions
    if (line.startsWith('+') || line.startsWith('-')) {
      const content = line.slice(1);
      const entityNames = extractEntityNamesFromContext(content);
      for (const name of entityNames) {
        entities.add(name);
      }
    }
  }

  return Array.from(entities);
}

/**
 * Extracts entity names from a line of code context.
 * Supports TypeScript, Python, Go, Rust, Java patterns.
 */
function extractEntityNamesFromContext(context: string): string[] {
  const names: string[] = [];

  // TypeScript/JavaScript: function/class/interface/type name
  let m = context.match(/(?:export\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|type|enum)\s+(\w+)/);
  if (m) names.push(m[1]);

  // Python: def/class name
  m = context.match(/(?:async\s+)?(?:def|class)\s+(\w+)/);
  if (m) names.push(m[1]);

  // Go: func (receiver) Name or func Name
  m = context.match(/func\s+(?:\([^)]+\)\s+)?(\w+)/);
  if (m) names.push(m[1]);

  // Rust: fn/struct/trait/enum/impl name
  m = context.match(/(?:pub\s+)?(?:async\s+)?(?:fn|struct|trait|enum)\s+(\w+)/);
  if (m) names.push(m[1]);

  // Java: method/class declarations
  m = context.match(/(?:public|private|protected)\s+(?:static\s+)?(?:abstract\s+)?(?:class|interface|enum|\w+(?:<[^>]+>)?)\s+(\w+)/);
  if (m) names.push(m[1]);

  return names;
}

// ---------------------------------------------------------------------------
// Coordinator output format for entity ownership
// ---------------------------------------------------------------------------

/**
 * Returns the additional JSON schema instructions for the coordinator
 * when entity-level ownership is enabled.
 */
export function getEntityOwnershipPromptSection(): string {
  return [
    '## Entity-Level Ownership (Advanced)',
    '',
    'For files that multiple tasks need to modify (large shared modules),',
    'you can use entity-level ownership instead of file-level ownership.',
    'Add an `entities` array to the sub-task to claim specific functions,',
    'classes, or methods within a shared file:',
    '',
    '```json',
    '{',
    '  "id": "task-1",',
    '  "files": ["src/new-file.ts"],',
    '  "entities": [',
    '    {',
    '      "file": "src/shared-module.ts",',
    '      "entity_name": "processData",',
    '      "entity_type": "function"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules for entity ownership:',
    '- Entity claims are for EXISTING entities in SHARED files.',
    '- Two tasks CANNOT claim the same entity.',
    '- Workers can only modify their claimed entities in shared files.',
    '- Use this when a file is too large to give to one worker.',
    '- Valid entity_type values: function, class, method, interface, type, constant.',
    '',
  ].join('\n');
}
