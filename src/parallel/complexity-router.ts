import {
  PARALLEL_MODELS,
  type SubTask,
  type TaskComplexity,
  type ComplexityAssessment,
} from './types.js';

// ---------------------------------------------------------------------------
// Complexity heuristics
// ---------------------------------------------------------------------------

interface ComplexitySignal {
  name: string;
  weight: number;
  score: number;  // 0-1
  reason: string;
}

/**
 * Assesses the complexity of a sub-task using structural heuristics.
 * Returns a ComplexityAssessment with the recommended model.
 *
 * Signals:
 * 1. File count — more files = more complex
 * 2. Prompt length — longer prompts usually mean more nuance
 * 3. Dependency count — tasks with dependencies need more careful handling
 * 4. Keyword signals — certain words indicate complexity
 * 5. Entity count — tasks with entity-level claims are more surgical
 */
export function assessComplexity(task: SubTask): ComplexityAssessment {
  const signals: ComplexitySignal[] = [];

  // Signal 1: File count
  const fileCount = task.files.length;
  const fileScore = Math.min(fileCount / 5, 1);
  signals.push({
    name: 'file_count',
    weight: 0.2,
    score: fileScore,
    reason: `${fileCount} file(s) to modify`,
  });

  // Signal 2: Prompt length (chars)
  const promptLen = task.prompt.length;
  const promptScore = Math.min(promptLen / 2000, 1);
  signals.push({
    name: 'prompt_length',
    weight: 0.15,
    score: promptScore,
    reason: `${promptLen} chars in prompt`,
  });

  // Signal 3: Dependency count
  const depCount = task.depends_on.length;
  const depScore = Math.min(depCount / 3, 1);
  signals.push({
    name: 'dependencies',
    weight: 0.15,
    score: depScore,
    reason: `${depCount} dependencies`,
  });

  // Signal 4: Keyword complexity signals
  const complexKeywords = [
    'refactor', 'migrate', 'security', 'authentication', 'authorization',
    'encryption', 'concurrent', 'parallel', 'async', 'stream', 'transform',
    'optimize', 'performance', 'cache', 'database', 'schema', 'state machine',
    'recursive', 'graph', 'tree', 'algorithm', 'protocol', 'parser',
    'architecture', 'redesign', 'backward compatible', 'breaking change',
  ];
  const simpleKeywords = [
    'rename', 'add field', 'update', 'fix typo', 'add comment', 'bump version',
    'add export', 'remove unused', 'reformat', 'simple', 'trivial', 'boilerplate',
    'scaffold', 'stub', 'placeholder', 'constant', 'config',
  ];

  const promptLower = task.prompt.toLowerCase();
  const complexHits = complexKeywords.filter((k) => promptLower.includes(k)).length;
  const simpleHits = simpleKeywords.filter((k) => promptLower.includes(k)).length;
  const keywordScore = Math.min(Math.max(complexHits - simpleHits, 0) / 4, 1);
  signals.push({
    name: 'keyword_signals',
    weight: 0.3,
    score: keywordScore,
    reason: `${complexHits} complex / ${simpleHits} simple keywords`,
  });

  // Signal 5: Read file count (needs to understand more context)
  const readCount = task.reads.length;
  const readScore = Math.min(readCount / 4, 1);
  signals.push({
    name: 'read_context',
    weight: 0.1,
    score: readScore,
    reason: `${readCount} files to read for context`,
  });

  // Signal 6: Entity-level claims (surgical = moderate complexity)
  const entityCount = task.entities?.length ?? 0;
  const entityScore = entityCount > 0 ? 0.5 : 0; // Entity work is moderate
  signals.push({
    name: 'entity_claims',
    weight: 0.1,
    score: entityScore,
    reason: entityCount > 0 ? `${entityCount} entity-level claims` : 'no entity claims',
  });

  // Compute weighted score
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const rawScore = signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

  // Classify
  const { complexity, model } = classifyComplexity(rawScore);

  return {
    complexity,
    score: Math.round(rawScore * 100) / 100,
    model,
    reasons: signals
      .filter((s) => s.score > 0)
      .map((s) => `${s.name}: ${s.reason} (${(s.score * 100).toFixed(0)}%)`),
  };
}

/**
 * Maps a complexity score to a TaskComplexity level and model.
 */
function classifyComplexity(score: number): { complexity: TaskComplexity; model: string } {
  if (score < 0.15) {
    return { complexity: 'trivial', model: PARALLEL_MODELS.architect }; // Sonnet
  }
  if (score < 0.35) {
    return { complexity: 'simple', model: PARALLEL_MODELS.architect }; // Sonnet
  }
  if (score < 0.6) {
    return { complexity: 'moderate', model: PARALLEL_MODELS.worker }; // Opus
  }
  return { complexity: 'complex', model: PARALLEL_MODELS.worker }; // Opus
}

/**
 * Routes a batch of tasks, returning the model assignment for each.
 * When dynamic routing is disabled, all tasks get the default worker model.
 */
export function routeTasks(
  tasks: SubTask[],
  dynamicRouting: boolean,
): Map<string, ComplexityAssessment> {
  const assessments = new Map<string, ComplexityAssessment>();

  for (const task of tasks) {
    if (dynamicRouting) {
      assessments.set(task.id, assessComplexity(task));
    } else {
      // Default: all tasks get Opus
      assessments.set(task.id, {
        complexity: 'moderate',
        score: 0.5,
        model: PARALLEL_MODELS.worker,
        reasons: ['dynamic routing disabled — using default worker model'],
      });
    }
  }

  return assessments;
}
