import { createAgent } from '../agents/factory.js';
import {
  PARALLEL_MODELS,
  type TaskDecomposition,
  type SharedContracts,
  type MergeResult,
  type MergeConflict,
  type WorkerResult,
} from './types.js';
import { resolveParallelRoleModel } from './model-selection.js';

// ---------------------------------------------------------------------------
// Main integrator prompt
// ---------------------------------------------------------------------------

export function buildIntegratorPrompt(
  decomposition: TaskDecomposition,
  contracts: SharedContracts,
  mergeResult: MergeResult,
  workerResults: WorkerResult[],
): string {
  const parts: string[] = [];

  const mergeMethod = mergeResult.weave_used
    ? 'merged using Weave (an entity-level semantic merge driver)'
    : 'merged using standard git merge';

  parts.push(
    'You are the Integrator in a parallel AI execution pipeline.',
    'Multiple AI workers have completed their sub-tasks in separate git worktrees,',
    `and their work has been ${mergeMethod}.`,
    '',
    'Your job is the FINAL PASS — wire everything together and ensure coherence.',
    '',
    '## Your Responsibilities',
    '',
    '1. Review the glue points defined by the Architect and ensure all connections are wired up.',
    '2. Wire up shared files: barrel exports (index.ts), package.json dependencies, config files.',
    '3. Ensure all imports between modules are correct and resolve properly.',
    '4. Run a mental compilation check — verify all type references, function calls, and imports resolve.',
    '5. If there are semantic merge conflicts (listed below), resolve them.',
    '',
    '## Rules',
    '',
    '- The shared_files are YOUR exclusive domain — only you modify these files.',
    '- Do NOT re-implement worker code. Only modify shared files and fix wiring issues.',
    '- If you add exports to barrel files, preserve existing exports.',
    '- All imports must use .js extensions (ESM convention).',
    '',
  );

  // Original task context
  parts.push(
    '## Original Task',
    '',
    decomposition.original_prompt,
    '',
  );

  // Shared files
  parts.push(
    '## Shared Files (your exclusive domain)',
    '',
    decomposition.shared_files.length > 0
      ? decomposition.shared_files.map((f) => `- ${f}`).join('\n')
      : '(none)',
    '',
  );

  // Glue points from architect
  if (contracts.glue_points.length > 0) {
    parts.push(
      '## Glue Points (from Architect)',
      '',
    );
    for (const gp of contracts.glue_points) {
      parts.push(
        `- **${gp.source_task} → ${gp.target_task}** (${gp.connection_type}): ${gp.description}`,
      );
    }
    parts.push('');
  }

  // Architect style guide
  parts.push(
    '## Style Guide',
    '',
    contracts.style_guide,
    '',
  );

  // Worker results — files modified + structured summaries
  parts.push(
    '## Files Modified by Workers',
    '',
  );
  for (const wr of workerResults) {
    parts.push(
      `### ${wr.sub_task_id} (branch: ${wr.branch_name})`,
      '',
      wr.files_modified.length > 0
        ? wr.files_modified.map((f) => `- ${f}`).join('\n')
        : '(no files modified)',
      '',
    );

    // Include structured summary if available
    if (wr.summary) {
      const s = wr.summary;
      if (s.exports_added.length > 0) {
        parts.push(`**Exports added:** ${s.exports_added.join(', ')}`);
      }
      if (s.contracts_implemented.length > 0) {
        parts.push(`**Contracts implemented:** ${s.contracts_implemented.join(', ')}`);
      }
      if (s.deviations.length > 0) {
        parts.push(`**Deviations:** ${s.deviations.join('; ')}`);
      }
      parts.push('');
    }

    // Note ownership violations
    if (wr.ownership_violations && wr.ownership_violations.length > 0) {
      parts.push(
        `**WARNING: Ownership violations (reverted):** ${wr.ownership_violations.join(', ')}`,
        '',
      );
    }
  }

  // Merge statistics
  parts.push(
    '## Merge Statistics',
    '',
    `- Weave used: ${mergeResult.weave_used ? 'yes' : 'no (git fallback)'}`,
    `- Files merged: ${mergeResult.merged_files.length}`,
    `- Structural conflicts auto-resolved by Weave: ${mergeResult.weave_resolved}`,
    `- Remaining conflicts: ${mergeResult.conflicts.length}`,
    '',
  );

  // Semantic conflicts that need resolution
  const semanticConflicts = mergeResult.conflicts.filter((c) => c.is_semantic);
  if (semanticConflicts.length > 0) {
    parts.push(
      '## SEMANTIC CONFLICTS (must resolve)',
      '',
      'These are genuine semantic conflicts that Weave could not auto-resolve.',
      'Two workers modified the same semantic entity (function, class, etc.) differently.',
      'You MUST resolve each one by producing the correct merged content.',
      '',
    );
    for (const conflict of semanticConflicts) {
      parts.push(
        `### Conflict in \`${conflict.file}\``,
        '',
        `Between worktrees: ${conflict.worktree_a} and ${conflict.worktree_b}`,
        '',
        '```',
        conflict.conflict_markers,
        '```',
        '',
      );
    }
  }

  // Non-semantic conflicts (informational)
  const nonSemanticConflicts = mergeResult.conflicts.filter((c) => !c.is_semantic);
  if (nonSemanticConflicts.length > 0) {
    parts.push(
      '## Other Conflicts',
      '',
      'These non-semantic conflicts also need resolution:',
      '',
    );
    for (const conflict of nonSemanticConflicts) {
      parts.push(
        `### Conflict in \`${conflict.file}\``,
        '',
        `Between worktrees: ${conflict.worktree_a} and ${conflict.worktree_b}`,
        '',
        '```',
        conflict.conflict_markers,
        '```',
        '',
      );
    }
  }

  // Structured integration checklist
  parts.push(
    '## Integration Checklist (follow in order)',
    '',
    '### Step 1: Resolve Conflicts',
    'For EACH conflict listed above:',
    '- [ ] Open the conflicted file',
    '- [ ] Remove all `<<<<<<<`, `=======`, `>>>>>>>` markers',
    '- [ ] Produce the correct merged content that preserves BOTH sides\' intent',
    '- [ ] Verify the resolved file is syntactically valid',
    '',
    '### Step 2: Wire Glue Points',
  );

  // Generate specific checklist items from glue points
  if (contracts.glue_points.length > 0) {
    for (const gp of contracts.glue_points) {
      parts.push(
        `- [ ] **${gp.source_task} → ${gp.target_task}** (${gp.connection_type}): ${gp.description}`,
      );
    }
  } else {
    parts.push('(no glue points defined)');
  }

  parts.push(
    '',
    '### Step 3: Update Barrel Exports',
    'For EACH shared file (index.ts, etc.):',
  );

  if (decomposition.shared_files.length > 0) {
    for (const sf of decomposition.shared_files) {
      parts.push(`- [ ] Update \`${sf}\` to re-export all new modules from workers`);
    }
  } else {
    parts.push('(no shared files declared)');
  }

  parts.push(
    '',
    '### Step 4: Fix Imports',
    '- [ ] Verify all cross-module imports resolve correctly',
    '- [ ] Ensure import paths use the correct extension (.js for ESM)',
    '- [ ] Check that no circular imports were introduced',
    '',
    '### Step 5: Final Verification',
    '- [ ] All conflict markers are gone',
    '- [ ] All files are syntactically valid',
    '- [ ] All imports resolve to existing exports',
    '- [ ] Config files (package.json, tsconfig) are consistent',
    '',
    'Do NOT explain your changes — just make them.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Conflict resolution prompt
// ---------------------------------------------------------------------------

export function buildConflictResolutionPrompt(
  conflicts: MergeConflict[],
  context: string,
): string {
  const parts: string[] = [];

  const hasWeave = conflicts.some((c) => c.is_semantic);

  parts.push(
    'You are resolving merge conflicts from a parallel AI execution pipeline.',
    ...(hasWeave
      ? [
          'These conflicts were identified by Weave (an entity-level semantic merge driver).',
          'Weave already resolved all structural conflicts (different functions added to the same class,',
          'different imports, etc.). What remains are cases where two workers modified the SAME semantic',
          'entity (e.g., the same function body, the same class method) in different ways.',
        ]
      : [
          'Standard git merge was used. These conflicts may be structural (independent changes in',
          'overlapping line ranges) or semantic (two workers modified the same entity differently).',
        ]),
    '',
    'Your job: produce the CORRECT merged version of each conflicted file.',
    '',
  );

  if (context) {
    parts.push(
      '## Context',
      '',
      context,
      '',
    );
  }

  parts.push(
    '## Conflicts',
    '',
  );

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i];
    parts.push(
      `### ${i + 1}. \`${conflict.file}\``,
      '',
      `Conflict between worktrees: **${conflict.worktree_a}** and **${conflict.worktree_b}**`,
      `Semantic conflict: ${conflict.is_semantic ? 'yes' : 'no'}`,
      '',
      'Conflict markers:',
      '',
      '```',
      conflict.conflict_markers,
      '```',
      '',
    );
  }

  parts.push(
    '## Instructions',
    '',
    'For each conflicted file, output the RESOLVED file content.',
    'Combine the intent of both sides — do not simply pick one side.',
    'Ensure the result is syntactically valid and semantically correct.',
    '',
    'Edit each conflicted file with the resolved content. Do NOT explain — just fix them.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runIntegrator(
  decomposition: TaskDecomposition,
  contracts: SharedContracts,
  mergeResult: MergeResult,
  workerResults: WorkerResult[],
  workingDirectory: string,
  timeout: number,
  agentType?: string,
  agentModel?: string,
): Promise<{ output: string; duration: number }> {
  const agent = createAgent(agentType);
  const prompt = buildIntegratorPrompt(
    decomposition,
    contracts,
    mergeResult,
    workerResults,
  );

  const startTime = Date.now();

  const result = await agent.execute(prompt, {
    workingDirectory,
    timeout,
    model: resolveParallelRoleModel(agentType, PARALLEL_MODELS.integrator, agentModel),
  });

  const duration = Date.now() - startTime;

  if (!result.success) {
    throw new Error(
      `Integrator agent failed (exit code ${result.exitCode}):\n${result.stderr}`,
    );
  }

  return {
    output: result.stdout,
    duration,
  };
}
