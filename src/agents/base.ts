import type { LockstepPolicy } from '../policy/types.js';

export interface AgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  combinedOutput: string; // for display only — NEVER hash this
  exitCode: number;
  duration: number; // ms
}

export interface AgentOptions {
  workingDirectory: string;
  timeout: number; // ms
  model?: string;
  effortLevel?: string;
  executionMode?: 'standard' | 'yolo';
  policy?: LockstepPolicy;
  env?: NodeJS.ProcessEnv;
  onOutput?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface Agent {
  name: string;
  execute(prompt: string, options: AgentOptions): Promise<AgentResult>;
}
