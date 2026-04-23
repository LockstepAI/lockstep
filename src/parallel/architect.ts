import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgent } from '../agents/factory.js';
import {
  PARALLEL_MODELS,
  type TaskDecomposition,
  type SharedContracts,
  type ArchitectResult,
} from './types.js';
import type { LanguageInfo } from './language-detect.js';
import { resolveParallelRoleModel } from './model-selection.js';
import { sanitizeFileExtension } from '../utils/path-security.js';

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildArchitectPrompt(
  decomposition: TaskDecomposition,
  context: string,
  language: LanguageInfo,
): string {
  const parts: string[] = [];

  parts.push(
    'You are the Architect in a parallel AI execution pipeline.',
    'The Coordinator has decomposed a task into sub-tasks that will be executed',
    'by separate AI workers in parallel, each in its own git worktree.',
    '',
    'Your job is to produce the SHARED CONTRACTS that all workers will consume.',
    'Workers will import from the contracts file but never modify it.',
    '',
    `The project is written in ${language.name}. All contracts MUST be valid ${language.name} code.`,
    '',
    '## Your Responsibilities',
    '',
    '1. Review all sub-tasks and their file ownership below.',
    '2. Identify the shared contracts that multiple sub-tasks need to share.',
    `3. Write shared contracts in ${language.name} using ${language.type_system}.`,
    '4. Define a style guide — naming conventions, error handling patterns, import conventions,',
    '   and any other patterns workers should follow for consistency.',
    '5. Define glue points — how the outputs of different sub-tasks connect to each other.',
    '   For example, if task-1 exports a function and task-2 imports it, that is a glue point.',
    '',
    '## Rules',
    '',
    `- The contracts_content MUST be valid ${language.name} that can be written to a \`${language.contracts_extension}\` file.`,
    '- Only include shared type definitions, interfaces, and constants that are SHARED across sub-tasks.',
    '- Do NOT include implementation code — only declarations and types.',
    '- KEEP contracts_content SHORT. Only essential shared types. Avoid comments, decorative separators, and verbose JSDoc. Brevity prevents response truncation.',
    '- Each glue point must reference valid sub-task IDs from the decomposition.',
    '- connection_type must be one of: "import", "export", "config", "type".',
    '',
    `## Example ${language.name} Contracts Format`,
    '',
    '```',
    language.contracts_template,
    '```',
    '',
  );

  if (context) {
    parts.push(
      '## Project Context',
      '',
      context,
      '',
    );
  }

  parts.push(
    '## Original Task',
    '',
    decomposition.original_prompt,
    '',
    '## Sub-Tasks',
    '',
  );

  for (const task of decomposition.sub_tasks) {
    parts.push(
      `### ${task.id}: ${task.name}`,
      '',
      `**Prompt:** ${task.prompt}`,
      `**Owns files:** ${task.files.join(', ') || '(none)'}`,
      `**Reads files:** ${task.reads.join(', ') || '(none)'}`,
      `**Depends on:** ${task.depends_on.join(', ') || '(none)'}`,
      '',
    );
  }

  parts.push(
    `**Shared files (handled by Integrator):** ${decomposition.shared_files.join(', ') || '(none)'}`,
    '',
    '## Output Format',
    '',
    'Output ONLY valid JSON matching this exact structure (no markdown, no explanation, no extra text):',
    '',
    '{',
    `  "contracts_content": "// ${language.name} code string with shared type definitions, interfaces, constants\\n...",`,
    '  "style_guide": "Naming conventions, error handling patterns, import conventions, ...",',
    `  "language": "${language.id}",`,
    `  "contracts_file_extension": "${language.contracts_extension}",`,
    '  "glue_points": [',
    '    {',
    '      "description": "Human-readable description of how these tasks connect",',
    '      "source_task": "task-1",',
    '      "target_task": "task-2",',
    '      "connection_type": "import"',
    '    }',
    '  ]',
    '}',
    '',
    'Output ONLY the JSON object. No markdown code fences. No explanation before or after.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

/**
 * Attempt to repair JSON truncated by model response length limits.
 * Handles the common case where contracts_content string is cut off.
 */
function repairTruncatedJSON(json: string): string | null {
  // Must at least have the opening brace
  if (!json.includes('{')) return null;

  // Check if it's truncated inside a string value
  // Count unescaped quotes to determine if we're inside a string
  let inString = false;
  let lastKey = '';
  let keyStart = -1;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\\' && inString) { i++; continue; }
    if (ch === '"') {
      if (!inString) keyStart = i + 1;
      inString = !inString;
      if (!inString && json[i + 1] === ':') {
        lastKey = json.slice(keyStart, i);
      }
    }
  }

  if (!inString) return null; // Not truncated inside a string

  // We're inside a string — close it and try to complete the JSON
  let repaired = json + '"';

  // If we were in contracts_content, close the object with minimal valid fields
  if (lastKey === 'contracts_content') {
    repaired += ', "style_guide": "See contracts for conventions", "language": "typescript", "contracts_file_extension": ".ts", "glue_points": []}';
  } else if (lastKey === 'style_guide') {
    repaired += ', "language": "typescript", "contracts_file_extension": ".ts", "glue_points": []}';
  } else {
    // Try to just close any open structures
    const openBraces = (json.match(/{/g) || []).length;
    const closeBraces = (json.match(/}/g) || []).length;
    const openBrackets = (json.match(/\[/g) || []).length;
    const closeBrackets = (json.match(/]/g) || []).length;
    repaired += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
    repaired += '}'.repeat(Math.max(0, openBraces - closeBraces));
  }

  return repaired;
}

export function parseArchitectOutput(output: string): SharedContracts {
  let jsonStr = output.trim();

  // Strip markdown code fences if present
  const fencedMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    jsonStr = fencedMatch[1].trim();
  }

  // Try to find a JSON object if there's surrounding text
  if (!jsonStr.startsWith('{')) {
    const objectStart = jsonStr.indexOf('{');
    const objectEnd = jsonStr.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
      jsonStr = jsonStr.slice(objectStart, objectEnd + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Attempt to recover truncated JSON — model may have hit response length limit
    const repaired = repairTruncatedJSON(jsonStr);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired);
      } catch {
        throw new Error(
          `Failed to parse architect output as JSON.\nRaw output:\n${output.slice(0, 500)}`,
        );
      }
    } else {
      throw new Error(
        `Failed to parse architect output as JSON.\nRaw output:\n${output.slice(0, 500)}`,
      );
    }
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.contracts_content !== 'string' || obj.contracts_content.length === 0) {
    throw new Error('Architect output missing or empty "contracts_content" field');
  }
  if (typeof obj.style_guide !== 'string' || obj.style_guide.length === 0) {
    throw new Error('Architect output missing or empty "style_guide" field');
  }
  if (!Array.isArray(obj.glue_points)) {
    throw new Error('Architect output missing "glue_points" array');
  }

  const validConnectionTypes = new Set(['import', 'export', 'config', 'type']);

  for (let i = 0; i < obj.glue_points.length; i++) {
    const gp = obj.glue_points[i] as Record<string, unknown>;
    const prefix = `glue_points[${i}]`;

    if (typeof gp.description !== 'string' || gp.description.length === 0) {
      throw new Error(`${prefix} missing or invalid "description"`);
    }
    if (typeof gp.source_task !== 'string' || gp.source_task.length === 0) {
      throw new Error(`${prefix} missing or invalid "source_task"`);
    }
    if (typeof gp.target_task !== 'string' || gp.target_task.length === 0) {
      throw new Error(`${prefix} missing or invalid "target_task"`);
    }
    if (typeof gp.connection_type !== 'string' || !validConnectionTypes.has(gp.connection_type)) {
      throw new Error(
        `${prefix} invalid "connection_type": expected one of ${[...validConnectionTypes].join(', ')}, got "${String(gp.connection_type)}"`,
      );
    }
  }

  return parsed as SharedContracts;
}

// ---------------------------------------------------------------------------
// Contracts file writer
// ---------------------------------------------------------------------------

export async function writeContractsFile(
  contracts: SharedContracts,
  worktreePath: string,
): Promise<string> {
  const dir = path.join(worktreePath, '.lockstep');
  await mkdir(dir, { recursive: true });

  const ext = sanitizeFileExtension(contracts.contracts_file_extension, '.ts');
  const filePath = path.join(dir, `shared-contracts${ext}`);
  await writeFile(filePath, contracts.contracts_content, 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runArchitect(
  decomposition: TaskDecomposition,
  context: string,
  workingDirectory: string,
  timeout: number,
  language: LanguageInfo,
  agentType?: string,
  agentModel?: string,
): Promise<ArchitectResult> {
  const agent = createAgent(agentType);
  const prompt = buildArchitectPrompt(decomposition, context, language);

  const startTime = Date.now();

  const result = await agent.execute(prompt, {
    workingDirectory,
    timeout,
    model: resolveParallelRoleModel(agentType, PARALLEL_MODELS.architect, agentModel),
  });

  const duration = Date.now() - startTime;

  if (!result.success) {
    throw new Error(
      `Architect agent failed (exit code ${result.exitCode}):\n${result.stderr}`,
    );
  }

  const contracts = parseArchitectOutput(result.stdout);

  return {
    contracts,
    raw_output: result.stdout,
    duration,
  };
}
