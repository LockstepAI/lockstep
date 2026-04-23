export interface ValidationResult {
  type: string;
  target: string;
  passed: boolean;
  details?: string;
  exit_code?: number;
  duration_ms?: number;
  stdout_hash?: string;
  stderr_hash?: string;
  stdout_truncated?: string;
  stderr_truncated?: string;
  optional?: boolean;
}

export interface ValidatorContext {
  workingDirectory: string;
  stepTimeout?: number;
}

export interface Validator {
  type: string;
  validate(config: Record<string, unknown>, context: ValidatorContext): Promise<ValidationResult>;
}
