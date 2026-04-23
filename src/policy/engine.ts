// ---------------------------------------------------------------------------
// Lockstep Policy Engine — evaluates agent actions against policy rules
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getJudgeModel } from '../utils/env.js';
import { toPortablePath, toRepoRelativePath } from '../utils/path-security.js';
import { runStructuredProviderPrompt } from './provider-runner.js';
import type {
  ApprovalRequest,
  LockstepPolicy,
  LockstepPolicyMode,
  PolicyDecision,
  PolicyLog,
} from './types.js';

interface CommandPattern {
  label: string;
  matches(command: string, segments: string[]): boolean;
}

function literalPattern(label: string): CommandPattern {
  const needle = label.toLowerCase();
  return {
    label,
    matches(command, segments): boolean {
      const haystacks = [command, ...segments].map((entry) => entry.toLowerCase());
      return haystacks.some((entry) => entry.includes(needle));
    },
  };
}

function regexPattern(label: string, regex: RegExp): CommandPattern {
  return {
    label,
    matches(command): boolean {
      return regex.test(command);
    },
  };
}

const BUILT_IN_REQUIRE_APPROVAL: CommandPattern[] = [
  literalPattern('DROP TABLE'),
  literalPattern('DROP DATABASE'),
  literalPattern('TRUNCATE TABLE'),
  literalPattern('DELETE FROM'),
  literalPattern('ALTER TABLE'),
  literalPattern('DROP INDEX'),
  literalPattern('rm -rf /'),
  literalPattern('rm -rf ~'),
  literalPattern('rm -rf .'),
  literalPattern('rm -rf *'),
  literalPattern('rmdir /s'),
  literalPattern('del /f /s /q'),
  literalPattern('git push --force'),
  literalPattern('git push -f'),
  literalPattern('git reset --hard'),
  literalPattern('git clean -fd'),
  literalPattern('mkfs'),
  literalPattern(':(){:|:&};:'),
  regexPattern('curl.*\\.env', /\bcurl\b[\s\S]*?\.env\b/i),
  regexPattern('wget.*\\.env', /\bwget\b[\s\S]*?\.env\b/i),
  literalPattern('npm publish'),
  literalPattern('pip upload'),
  literalPattern('gem push'),
];

const ABSOLUTE_DENY: CommandPattern[] = [
  literalPattern(':(){:|:&};:'),
  literalPattern('rm -rf /'),
  literalPattern('mkfs'),
  literalPattern('dd if=/dev/zero'),
];

const DEFAULT_REVIEW_THRESHOLD = 8;
const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;

function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | '`' | null = null;
  let escaped = false;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const pair = command.slice(i, i + 2);

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== '\'') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (pair === '&&' || pair === '||') {
      flush();
      i++;
      continue;
    }

    if (char === ';' || char === '|' || char === '\n') {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAllowOnlyPattern(segment: string, pattern: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }

  const regex = new RegExp(`^${escapeRegExp(trimmedPattern)}(?:\\s|$)`, 'i');
  return regex.test(segment.trim());
}

function extractUrls(command: string): string[] {
  const matches = command.match(/\bhttps?:\/\/[^\s'"]+/gi);
  return matches ?? [];
}

function normalizePolicyPathPattern(
  workingDirectory: string,
  pattern: string,
): string {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return '';
  }

  if (path.isAbsolute(trimmed)) {
    try {
      return toRepoRelativePath(workingDirectory, trimmed);
    } catch {
      return toPortablePath(trimmed);
    }
  }

  return toPortablePath(path.normalize(trimmed)).replace(/^\.\//, '');
}

function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith('/')) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (!normalizedPattern.includes('*')) {
    return (
      normalizedPath === normalizedPattern ||
      normalizedPath.startsWith(`${normalizedPattern}/`)
    );
  }

  const regex = new RegExp(
    '^' +
      escapeRegExp(normalizedPattern)
        .replace(/\\\*\\\*/g, '.*')
        .replace(/\\\*/g, '[^/]*') +
      '$',
    'i',
  );

  return regex.test(normalizedPath);
}

function matchHostPattern(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }

  return normalizedHost === normalizedPattern;
}

interface ReviewRunResult {
  allowed: boolean;
  score?: number;
  summary?: string;
  error?: string;
}

function buildReviewSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'verdict', 'reasoning'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 10 },
      verdict: { type: 'string', enum: ['allow', 'escalate'] },
      reasoning: { type: 'string', minLength: 1 },
      risk_tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}

export class PolicyEngine {
  private readonly policy: LockstepPolicy;
  private readonly log: PolicyLog;
  private readonly approvedCommands: Set<string>;
  private readonly workingDirectory: string;

  constructor(policy: LockstepPolicy, workingDirectory = '.') {
    this.policy = policy;
    this.log = { decisions: [], blocked_count: 0, allowed_count: 0, approval_count: 0 };
    this.workingDirectory = path.resolve(workingDirectory);
    this.approvedCommands = this.loadApprovals();
  }

  private getMode(): LockstepPolicyMode {
    return this.policy.mode ?? 'strict';
  }

  /** Evaluate a Bash command against the policy */
  evaluateShellCommand(command: string): PolicyDecision {
    const trimmedCommand = command.trim();
    const segments = splitShellCommands(trimmedCommand);
    const timestamp = new Date().toISOString();

    for (const pattern of ABSOLUTE_DENY) {
      if (pattern.matches(trimmedCommand, segments)) {
        return this.record({
          allowed: false,
          needs_approval: false,
          mode: this.getMode(),
          action: command,
          tool: 'Bash',
          reason: `Permanently blocked: "${pattern.label}" — cannot be approved`,
          rule: `absolute:deny:${pattern.label}`,
          timestamp,
        });
      }
    }

    if (this.policy.shell?.deny) {
      for (const pattern of this.policy.shell.deny) {
        if (trimmedCommand.toLowerCase().includes(pattern.toLowerCase())) {
          return this.record({
            allowed: false,
            needs_approval: false,
            mode: this.getMode(),
            action: command,
            tool: 'Bash',
            reason: `Blocked by policy (no approval): "${pattern}"`,
            rule: `policy:shell:deny:${pattern}`,
            timestamp,
          });
        }
      }
    }

    if (this.policy.shell?.allow_only) {
      const allowed = segments.length > 0 && segments.every((segment) =>
        this.policy.shell?.allow_only?.some((pattern) =>
          matchesAllowOnlyPattern(segment, pattern),
        ),
      );

      if (!allowed) {
        return this.record({
          allowed: false,
          needs_approval: false,
          mode: this.getMode(),
          action: command,
          tool: 'Bash',
          reason: 'Command not in allow_only whitelist',
          rule: 'policy:shell:allow_only',
          timestamp,
        });
      }
    }

    const networkDecision = this.evaluateCommandNetworkAccess(command, timestamp);
    if (networkDecision) {
      return networkDecision;
    }

    const commandHash = this.hashCommand(trimmedCommand);
    if (this.approvedCommands.has(commandHash)) {
      return this.record({
        allowed: true,
        needs_approval: false,
        mode: this.getMode(),
        action: command,
        tool: 'Bash',
        reason: 'Previously approved by developer',
        rule: 'approved',
        approved_by: 'developer',
        timestamp,
      });
    }

    for (const pattern of BUILT_IN_REQUIRE_APPROVAL) {
      if (pattern.matches(trimmedCommand, segments)) {
        return this.resolveRiskyAction({
          action: command,
          tool: 'Bash',
          pattern: pattern.label,
          reason: `Risky shell action matched "${pattern.label}"`,
          rule: `builtin:require_approval:${pattern.label}`,
          timestamp,
        });
      }
    }

    if (this.policy.shell?.require_approval) {
      for (const pattern of this.policy.shell.require_approval) {
        if (trimmedCommand.toLowerCase().includes(pattern.toLowerCase())) {
          return this.resolveRiskyAction({
            action: command,
            tool: 'Bash',
            pattern,
            reason: `Risky shell action matched "${pattern}"`,
            rule: `policy:shell:require_approval:${pattern}`,
            timestamp,
          });
        }
      }
    }

    return this.record({
      allowed: true,
      needs_approval: false,
      mode: this.getMode(),
      action: command,
      tool: 'Bash',
      timestamp,
    });
  }

  /** Evaluate a file write/edit against the policy */
  evaluateFileWrite(filePath: string): PolicyDecision {
    const timestamp = new Date().toISOString();
    let normalizedPath: string;

    try {
      normalizedPath = toRepoRelativePath(this.workingDirectory, filePath);
    } catch {
      const approvalId = this.createApprovalRequest(`write:${filePath}`, 'outside working directory', 'Write');
      return this.record({
        allowed: false,
        needs_approval: true,
        approval_id: approvalId,
        mode: this.getMode(),
        action: `write:${filePath}`,
        tool: 'Write',
        reason: 'Path escapes working directory — requires approval',
        rule: 'policy:filesystem:outside-root',
        timestamp,
      });
    }

    const action = `write:${normalizedPath}`;
    const fileHash = this.hashCommand(action);
    if (this.approvedCommands.has(fileHash)) {
      return this.record({
        allowed: true,
        needs_approval: false,
        mode: this.getMode(),
        action,
        tool: 'Write',
        reason: 'Previously approved by developer',
        rule: 'approved',
        approved_by: 'developer',
        timestamp,
      });
    }

    if (this.policy.filesystem?.protected) {
      for (const pattern of this.policy.filesystem.protected) {
        const normalizedPattern = normalizePolicyPathPattern(this.workingDirectory, pattern);
        if (matchGlob(normalizedPath, normalizedPattern)) {
          return this.resolveRiskyAction({
            action,
            tool: 'Write',
            pattern: normalizedPattern,
            reason: `Protected path matched "${pattern}"`,
            rule: `policy:filesystem:protected:${pattern}`,
            timestamp,
          });
        }
      }
    }

    if (this.policy.filesystem?.writable) {
      const isWritable = this.policy.filesystem.writable.some((pattern) => {
        const normalizedPattern = normalizePolicyPathPattern(this.workingDirectory, pattern);
        return matchGlob(normalizedPath, normalizedPattern);
      });

      if (!isWritable) {
        return this.resolveRiskyAction({
          action,
          tool: 'Write',
          pattern: 'outside writable paths',
          reason: 'Path is outside the writable list',
          rule: 'policy:filesystem:writable',
          timestamp,
        });
      }
    }

    return this.record({
      allowed: true,
      needs_approval: false,
      mode: this.getMode(),
      action,
      tool: 'Write',
      timestamp,
    });
  }

  /** Evaluate a direct network request against the policy */
  evaluateNetworkRequest(url: string, tool = 'Network'): PolicyDecision {
    const timestamp = new Date().toISOString();
    return this.evaluateNetworkUrl(url, tool, timestamp);
  }

  /** Approve a pending request by its ID */
  approve(approvalId: string): boolean {
    const approvalsDir = path.join(this.workingDirectory, '.lockstep', 'approvals');
    const requestFile = path.join(approvalsDir, `${approvalId}.json`);

    if (!existsSync(requestFile)) return false;

    const request = JSON.parse(readFileSync(requestFile, 'utf-8')) as ApprovalRequest;
    request.status = 'approved';
    request.resolved_at = new Date().toISOString();
    writeFileSync(requestFile, JSON.stringify(request, null, 2));

    this.approvedCommands.add(this.hashCommand(request.action));
    this.saveApprovals();

    this.log.approval_count++;
    return true;
  }

  /** Get all pending approval requests */
  getPending(): ApprovalRequest[] {
    const approvalsDir = path.join(this.workingDirectory, '.lockstep', 'approvals');
    if (!existsSync(approvalsDir)) return [];

    return readdirSync(approvalsDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) =>
        JSON.parse(readFileSync(path.join(approvalsDir, fileName), 'utf-8')) as ApprovalRequest,
      )
      .filter((request) => request.status === 'pending');
  }

  getLog(): PolicyLog {
    return { ...this.log };
  }

  getBlocked(): PolicyDecision[] {
    return this.log.decisions.filter((decision) => !decision.allowed);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private evaluateCommandNetworkAccess(
    command: string,
    timestamp: string,
  ): PolicyDecision | null {
    const urls = extractUrls(command);
    if (urls.length === 0) {
      return null;
    }

    for (const url of urls) {
      const decision = this.evaluateNetworkUrl(url, 'Bash', timestamp, command);
      if (!decision.allowed) {
        return decision;
      }
    }

    return null;
  }

  private evaluateNetworkUrl(
    url: string,
    tool: string,
    timestamp: string,
    actionOverride?: string,
  ): PolicyDecision {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(url);
    } catch {
      return this.record({
        allowed: false,
        needs_approval: false,
        mode: this.getMode(),
        action: actionOverride ?? url,
        tool,
        reason: `Invalid network URL: ${url}`,
        rule: 'policy:network:invalid-url',
        timestamp,
      });
    }

    const networkPolicy = this.policy.network;
    if (!networkPolicy) {
      return this.record({
        allowed: true,
        needs_approval: false,
        mode: this.getMode(),
        action: actionOverride ?? url,
        tool,
        timestamp,
      });
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const allowedHosts = networkPolicy.allow ?? [];
    const matchesAllowList = allowedHosts.some((pattern) =>
      matchHostPattern(hostname, pattern),
    );

    if (allowedHosts.length > 0 && !matchesAllowList) {
      return this.record({
        allowed: false,
        needs_approval: false,
        mode: this.getMode(),
        action: actionOverride ?? url,
        tool,
        reason: `Network access blocked for host: ${hostname}`,
        rule: 'policy:network:allow',
        timestamp,
      });
    }

    if (networkPolicy.block_all_other && !matchesAllowList) {
      return this.record({
        allowed: false,
        needs_approval: false,
        mode: this.getMode(),
        action: actionOverride ?? url,
        tool,
        reason: `Network access blocked for host: ${hostname}`,
        rule: 'policy:network:block_all_other',
        timestamp,
      });
    }

    return this.record({
      allowed: true,
      needs_approval: false,
      mode: this.getMode(),
      action: actionOverride ?? url,
      tool,
      timestamp,
    });
  }

  private resolveRiskyAction(input: {
    action: string;
    tool: string;
    pattern: string;
    reason: string;
    rule: string;
    timestamp: string;
  }): PolicyDecision {
    const mode = this.getMode();
    const reviewResult = this.maybeRunReview(input.action, input.tool);

    if (mode === 'yolo') {
      return this.record({
        allowed: true,
        needs_approval: false,
        mode,
        reviewed: reviewResult.reviewed,
        review_score: reviewResult.score,
        review_summary: reviewResult.summary,
        action: input.action,
        tool: input.tool,
        reason: reviewResult.summary
          ? `Allowed by yolo mode after review: ${reviewResult.summary}`
          : `Allowed by yolo mode: ${input.reason}`,
        rule: `${input.rule}:yolo`,
        timestamp: input.timestamp,
      });
    }

    if (mode === 'review' && reviewResult.allowed) {
      return this.record({
        allowed: true,
        needs_approval: false,
        mode,
        reviewed: reviewResult.reviewed,
        review_score: reviewResult.score,
        review_summary: reviewResult.summary,
        action: input.action,
        tool: input.tool,
        reason: reviewResult.summary
          ? `Allowed after AI review: ${reviewResult.summary}`
          : `Allowed after AI review for ${input.pattern}`,
        rule: `${input.rule}:review`,
        timestamp: input.timestamp,
      });
    }

    const approvalId = this.createApprovalRequest(input.action, input.pattern, input.tool);
    return this.record({
      allowed: false,
      needs_approval: true,
      approval_id: approvalId,
      mode,
      reviewed: reviewResult.reviewed,
      review_score: reviewResult.score,
      review_summary: reviewResult.summary,
      action: input.action,
      tool: input.tool,
      reason: reviewResult.summary
        ? `Escalated for developer approval: ${reviewResult.summary}`
        : `Requires developer approval: ${input.reason}`,
      rule: input.rule,
      timestamp: input.timestamp,
    });
  }

  private maybeRunReview(action: string, tool: string): ReviewRunResult & { reviewed: boolean } {
    const mode = this.getMode();
    if (mode === 'strict') {
      return { allowed: false, reviewed: false };
    }

    if (this.policy.review?.enabled === false) {
      return { allowed: false, reviewed: false };
    }

    const threshold = this.policy.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD;
    const timeoutMs = Math.trunc((this.policy.review?.timeout_seconds ?? (DEFAULT_REVIEW_TIMEOUT_MS / 1000)) * 1000);
    const model = getJudgeModel(this.policy.review?.model);
    const provider = this.policy.review?.provider ?? 'codex';

    const prompt = [
      'You are Lockstep policy review.',
      'Decide whether this action should be auto-allowed inside the current repository.',
      'Be conservative with destructive actions, production deploys, secrets, and irreversible commands.',
      'Allow only when the action is clearly expected and low-risk in repository context.',
      '',
      `Tool: ${tool}`,
      `Action: ${action}`,
      `Mode: ${mode}`,
      `Threshold: ${threshold}/10`,
      '',
      'Respond with JSON only.',
      'Use verdict "allow" only if the action is safe enough to proceed automatically.',
      'Use verdict "escalate" for anything ambiguous, destructive, or higher-risk.',
    ].join('\n');

    try {
      const parsed = runStructuredProviderPrompt({
        provider,
        model,
        prompt,
        schema: buildReviewSchema(),
        workingDirectory: this.workingDirectory,
        timeoutMs,
      }) as {
        score?: unknown;
        verdict?: unknown;
        reasoning?: unknown;
        risk_tags?: unknown;
      };
      const score = Number(parsed.score);
      const verdict = parsed.verdict === 'allow' ? 'allow' : 'escalate';
      const reasoning = typeof parsed.reasoning === 'string'
        ? parsed.reasoning.trim()
        : 'AI review returned no reasoning.';
      const riskTags = Array.isArray(parsed.risk_tags)
        ? parsed.risk_tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : [];
      const summary = riskTags.length > 0
        ? `${reasoning} Tags: ${riskTags.join(', ')}.`
        : reasoning;

      return {
        allowed: verdict === 'allow' && Number.isFinite(score) && score >= threshold,
        reviewed: true,
        score: Number.isFinite(score) ? score : undefined,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        allowed: false,
        reviewed: true,
        error: message,
        summary: `AI review unavailable: ${message}`,
      };
    }
  }

  private record(decision: PolicyDecision): PolicyDecision {
    this.log.decisions.push(decision);
    if (decision.allowed) {
      this.log.allowed_count++;
    } else {
      this.log.blocked_count++;
    }

    const lockstepDir = path.join(this.workingDirectory, '.lockstep');
    if (!existsSync(lockstepDir)) {
      mkdirSync(lockstepDir, { recursive: true });
    }
    const logPath = path.join(lockstepDir, 'policy-log.jsonl');
    writeFileSync(logPath, `${JSON.stringify(decision)}\n`, {
      encoding: 'utf-8',
      flag: 'a',
    });

    return decision;
  }

  private hashCommand(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
  }

  private createApprovalRequest(action: string, pattern: string, tool: string): string {
    const id = randomBytes(8).toString('hex');
    const approvalsDir = path.join(this.workingDirectory, '.lockstep', 'approvals');
    if (!existsSync(approvalsDir)) mkdirSync(approvalsDir, { recursive: true });

    const request: ApprovalRequest = {
      id,
      action,
      tool,
      reason: `Matches pattern: "${pattern}"`,
      rule: `${tool}:${pattern}`,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };

    writeFileSync(path.join(approvalsDir, `${id}.json`), JSON.stringify(request, null, 2));
    return id;
  }

  private loadApprovals(): Set<string> {
    const file = path.join(this.workingDirectory, '.lockstep', 'approved-commands.json');
    if (!existsSync(file)) return new Set();
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as string[];
      return new Set(data);
    } catch {
      return new Set();
    }
  }

  private saveApprovals(): void {
    const dir = path.join(this.workingDirectory, '.lockstep');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'approved-commands.json'),
      JSON.stringify([...this.approvedCommands]),
    );
  }
}
