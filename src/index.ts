// ---------------------------------------------------------------------------
// Barrel export for programmatic usage of Lockstep
// ---------------------------------------------------------------------------

// Crypto utilities
export { sha256, hashObject, hashFileBytes } from './utils/crypto.js';

// Core hashing and receipt types
export {
  computeStepHash,
  computeCriteriaHash,
  normalizeCriteria,
} from './core/hasher.js';
export type {
  LockstepReceipt,
  StepProof,
  AttemptRecord,
} from './core/hasher.js';

// Spec parser and types
export { parseSpec, validateSpec } from './core/parser.js';
export type {
  LockstepSpec,
  LockstepStep,
  LockstepValidator,
} from './core/parser.js';

// Validator types
export type { ValidationResult } from './validators/base.js';

// Version utility
export { getLockstepVersion } from './utils/version.js';

// Receipt generation
export { generateReceiptFiles } from './core/receipt.js';

// Spec generation
export { generateSpecs } from './generators/spec-generator.js';
export type { GeneratedSpec, GenerateResult } from './generators/spec-generator.js';

// Parallel execution
export { executeParallelStep } from './parallel/parallel-executor.js';
export type { ParallelConfig, ParallelStepResult, TaskDecomposition, SharedContracts } from './parallel/types.js';
