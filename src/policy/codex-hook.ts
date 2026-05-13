#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LockstepPolicy, PolicyDecision } from './types.js';
import { PolicyEngine } from './engine.js';

interface CodexHookPayload {
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

interface CodexToolInput {
  command?: unknown;
  file_path?: unknown;
  path?: unknown;
  target_file?: unknown;
}

interface CodexHookBlockOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function loadPolicy(policyPath: string | undefined): LockstepPolicy {
  if (!policyPath) {
    return {};
  }

  return JSON.parse(readFileSync(policyPath, 'utf-8')) as LockstepPolicy;
}

function getShellCommand(payload: CodexHookPayload): string {
  const input = isRecord(payload.tool_input)
    ? payload.tool_input as CodexToolInput
    : {};
  return typeof input.command === 'string' ? input.command : '';
}

function getToolName(payload: CodexHookPayload): string {
  return typeof payload.tool_name === 'string' ? payload.tool_name : '';
}

function candidatePaths(payload: CodexHookPayload): string[] {
  const input = isRecord(payload.tool_input)
    ? payload.tool_input as CodexToolInput
    : {};
  return ['file_path', 'path', 'target_file']
    .map((key) => input[key as keyof CodexToolInput])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function formatBlockReason(decision: PolicyDecision): string {
  const reason = decision.reason ?? 'Blocked by Lockstep policy.';
  return decision.rule ? `${reason} Rule: ${decision.rule}.` : reason;
}

function toStrictHookPolicy(policy: LockstepPolicy): LockstepPolicy {
  return {
    ...policy,
    mode: 'strict',
    review: {
      ...policy.review,
      enabled: false,
    },
  };
}

export function evaluatePreToolUsePayload(
  payload: CodexHookPayload,
  policy: LockstepPolicy,
  workingDirectory: string,
): CodexHookBlockOutput | null {
  if (payload.hook_event_name !== 'PreToolUse') {
    return null;
  }

  const command = getShellCommand(payload);
  const toolName = getToolName(payload);
  let decision: PolicyDecision | null = null;
  const engine = new PolicyEngine(toStrictHookPolicy(policy), workingDirectory);

  if (toolName === 'Bash' || (!toolName && command)) {
    if (!command) {
      return null;
    }
    decision = engine.evaluateShellCommand(command);
  } else if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    for (const filePath of candidatePaths(payload)) {
      const readDecision = engine.evaluateFileRead(filePath);
      if (!readDecision.allowed) {
        decision = readDecision;
        break;
      }
    }
  } else if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    for (const filePath of candidatePaths(payload)) {
      const writeDecision = engine.evaluateFileWrite(filePath);
      if (!writeDecision.allowed) {
        decision = writeDecision;
        break;
      }
    }
  }

  if (!decision || decision.allowed) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: formatBlockReason(decision),
    },
  };
}

function hookFailure(message: string): CodexHookBlockOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Lockstep policy hook failed closed: ${message}`,
    },
  };
}

export async function main(): Promise<void> {
  try {
    const payload = JSON.parse(await readStdin()) as CodexHookPayload;
    const workingDirectory = process.env.LOCKSTEP_CODEX_WORKING_DIR
      ?? (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    const policy = loadPolicy(process.env.LOCKSTEP_CODEX_POLICY_PATH);
    const output = evaluatePreToolUsePayload(payload, policy, workingDirectory);

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(hookFailure(message))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
