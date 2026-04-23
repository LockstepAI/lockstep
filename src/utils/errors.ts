export class LockstepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockstepError';
  }
}

export class SpecValidationError extends LockstepError {
  constructor(message: string, public readonly details?: string[]) {
    super(message);
    this.name = 'SpecValidationError';
  }
}

export class AgentExecutionError extends LockstepError {
  constructor(message: string, public readonly exitCode?: number) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export class ValidatorError extends LockstepError {
  constructor(message: string, public readonly validatorType?: string) {
    super(message);
    this.name = 'ValidatorError';
  }
}

export class JudgeError extends LockstepError {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

export class JudgeInfraError extends JudgeError {
  constructor(message: string, rawOutput?: string) {
    super(message, rawOutput);
    this.name = 'JudgeInfraError';
  }
}

export class ReceiptVerificationError extends LockstepError {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptVerificationError';
  }
}
