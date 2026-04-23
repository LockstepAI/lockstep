// ---------------------------------------------------------------------------
// Lockstep Policy — runtime enforcement for AI agent actions
// ---------------------------------------------------------------------------

import type { ProviderName } from '../utils/providers.js';

export type LockstepPolicyMode = 'strict' | 'review' | 'yolo';

/** Policy definition — loaded from .lockstep-policy.yml or spec config */
export interface LockstepPolicy {
  /** How risky actions should be handled */
  mode?: LockstepPolicyMode;

  /** Optional AI review settings for `review` / `yolo` modes */
  review?: {
    /** Review provider override; defaults to the primary Lockstep judge provider */
    provider?: ProviderName;
    /** Review model override; defaults to the provider's latest/default model */
    model?: string;
    /** Minimum score required for auto-allow in review mode */
    threshold?: number;
    /** Timeout for the review subprocess */
    timeout_seconds?: number;
    /** Disable the AI review pass even in review/yolo modes */
    enabled?: boolean;
  };

  /** Shell command restrictions */
  shell?: {
    /** Commands containing these patterns are blocked permanently */
    deny?: string[];
    /** Commands matching these patterns are blocked but can be approved by the developer */
    require_approval?: string[];
    /** If set, ONLY these commands are allowed (whitelist mode) */
    allow_only?: string[];
  };

  /** Filesystem access restrictions */
  filesystem?: {
    /** Paths the agent can write to (glob patterns) */
    writable?: string[];
    /** Paths that cannot be modified under any circumstances */
    protected?: string[];
  };

  /** Network access restrictions */
  network?: {
    /** Allowed outbound domains */
    allow?: string[];
    /** Block all domains not in the allow list */
    block_all_other?: boolean;
  };
}

/** Result of evaluating an action against a policy */
export interface PolicyDecision {
  allowed: boolean;
  /** Whether this was blocked pending human approval */
  needs_approval: boolean;
  /** Policy mode that produced this decision */
  mode?: LockstepPolicyMode;
  /** Whether an AI review pass was run */
  reviewed?: boolean;
  /** Score returned by the AI reviewer, if present */
  review_score?: number;
  /** Reviewer explanation, if present */
  review_summary?: string;
  /** Unique ID for approval tracking */
  approval_id?: string;
  action: string;
  tool: string;
  reason?: string;
  /** The policy rule that triggered the decision */
  rule?: string;
  /** Who approved it (if approved) */
  approved_by?: string;
  timestamp: string;
}

/** A pending approval request shown to the developer */
export interface ApprovalRequest {
  id: string;
  action: string;
  tool: string;
  reason: string;
  rule: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'denied';
  resolved_at?: string;
}

/** Log of all policy decisions during a run */
export interface PolicyLog {
  decisions: PolicyDecision[];
  blocked_count: number;
  allowed_count: number;
  approval_count: number;
}
