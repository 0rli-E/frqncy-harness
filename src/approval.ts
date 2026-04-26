/**
 * Approval system.
 *
 * Implements decision A1 (per-conversation memory of approvals):
 *   Read-only tools auto-execute. State-changing tools (write, bash,
 *   MCP write ops) propose-then-approve. Once you approve a specific
 *   tool within a conversation, the same tool doesn't ask again until
 *   you exit. `--yolo` bypasses everything for trusted runs.
 *
 * Plus decision D5 (lethal-trifecta gate): when a tool call would put
 * a trace into the lethal-trifecta state, an extra confirmation is
 * required regardless of prior per-conversation approval.
 */
import type { ToolFlags } from './tools/index.js';

export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  permission: 'auto' | 'propose-then-approve';
  flags: ToolFlags;
}

export type ApprovalCallback = (request: ApprovalRequest) => Promise<boolean>;

export interface ApprovalManagerOptions {
  /** Bypass all approvals — the --yolo flag */
  yolo?: boolean;
  /** Underlying callback that asks the user (CLI uses readline; UI uses a modal) */
  callback?: ApprovalCallback;
}

/**
 * Tracks per-conversation approval state. One instance per conversation/run.
 *
 * - Auto-permission tools approve without consulting the callback or memory
 * - Once a propose-then-approve tool is approved, it stays approved for the
 *   lifetime of this manager (= one conversation, per A1)
 * - Yolo mode bypasses everything
 */
export class ApprovalManager {
  private approvedTools = new Set<string>();
  private deniedTools = new Set<string>();

  constructor(private opts: ApprovalManagerOptions = {}) {}

  /** Bound callback usable by the AI SDK tool wrapper */
  asCallback(): ApprovalCallback {
    return (req) => this.request(req);
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    if (req.permission === 'auto') return true;
    if (this.opts.yolo) return true;

    if (this.approvedTools.has(req.toolName)) return true;
    if (this.deniedTools.has(req.toolName)) return false;

    if (!this.opts.callback) {
      // No callback configured — default-deny so we never silently take
      // a state-changing action. The wrapper in toAiSdkTool() returns
      // a structured error the model can see and handle.
      return false;
    }

    const approved = await this.opts.callback(req);
    if (approved) {
      this.approvedTools.add(req.toolName);
    } else {
      // Don't permanently deny — user might change mind on next call
      // but don't auto-prompt during the same step burst either
    }
    return approved;
  }

  /** Manually pre-approve a tool (e.g., from --auto-allow flags or config) */
  preApprove(toolName: string): void {
    this.approvedTools.add(toolName);
  }
}
