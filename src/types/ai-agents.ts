// ============================================================
// AI Organization types (migrations 041-043)
//
// The business-owner-level AI Co-Founder and the specialized AI
// Employees beneath it, the tasks they're assigned, and the
// append-only activity trail. This is the "AI Business Operating
// System" layer on top of the existing WhatsApp CRM modules.
// ============================================================

export type AiAgentRole =
  | 'co_founder'
  | 'sales'
  | 'marketing'
  | 'support'
  | 'operations'
  | 'social'
  | 'finance'
  | 'hr'
  | 'custom';

export type AiAgentStatus = 'active' | 'paused';

/**
 * An AI agent: either the single AI Co-Founder (role `co_founder`,
 * manager_id NULL, top of the org tree) or an AI Employee under it.
 * Custom employees are created by describing the job; the app
 * generates `instructions` / `responsibilities` from that description.
 */
export interface AiAgent {
  id: string;
  account_id: string;
  name: string;
  role: AiAgentRole;
  /** Short label e.g. "Sales AI"; falls back to `name` for custom roles. */
  title?: string | null;
  /** Operating instructions / system prompt. */
  instructions?: string | null;
  /** Structured list of responsibilities, rendered + fed to the Co-Founder. */
  responsibilities: string[];
  /** Allow-list of capabilities the agent may use (`send_whatsapp`, ...). */
  tools: string[];
  /** Org tree. NULL for the Co-Founder. */
  manager_id?: string | null;
  /** Denormalised mirror of manager_id. */
  reports_to?: string | null;
  status: AiAgentStatus;
  /** Owner-provided free-text job description (custom roles). */
  job_description?: string | null;
  /** Hard on/off for scheduled work (monitor loop only analyses enabled). */
  is_enabled: boolean;
  /** Last scheduled analysis run timestamp (Agent Org "analyzed N ago"). */
  last_monitor_run_at?: string | null;
  /** Last monitor-loop error, so a bad key/model surfaces in the UI. */
  last_monitor_error?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;

  // hydrated / computed (not columns)
  manager?: AiAgent;
  open_tasks?: number;
}

export type AiTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type AiTaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * A goal/task the AI Co-Founder (or the owner) assigned to an AI
 * Employee (or to the Co-Founder itself). The employee completes work,
 * records a result, and can escalate blocking issues back up the tree.
 */
export interface AiTask {
  id: string;
  account_id: string;
  /** The agent that is supposed to do the work. */
  assignee_agent_id: string;
  /** Who handed the task out. NULL for owner-created tasks. */
  created_by_agent_id?: string | null;
  created_by_user_id?: string | null;
  title: string;
  description?: string | null;
  status: AiTaskStatus;
  priority: AiTaskPriority;
  due_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  /** 0-100, reported by the employee. */
  progress: number;
  /** Human text result posted back by the employee. */
  result?: string | null;
  /** Structured result payload. */
  result_metadata?: Record<string, unknown> | null;
  escalated: boolean;
  escalation_note?: string | null;
  resolved_by_agent_id?: string | null;
  parent_task_id?: string | null;
  created_at: string;
  updated_at: string;

  // hydrated
  assignee?: AiAgent;
}

export type AgentActivityType =
  | 'task_delegated'
  | 'task_completed'
  | 'task_escalated'
  | 'task_status'
  | 'report_sent'
  | 'message_sent'
  | 'deal_updated'
  | 'contact_updated'
  | 'analysis_run'
  | 'goal_created'
  | 'tool_used'
  | 'system';

/** One entry in an AI agent's append-only activity history. */
export interface AgentActivity {
  id: string;
  account_id: string;
  agent_id?: string | null;
  type: AgentActivityType | string;
  summary: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

/** Valid capability keys an agent may hold in its `tools` array. */
export const AI_AGENT_TOOL_REGISTRY = [
  'analyze',
  'report',
  'delegate',
  'review',
  'send_whatsapp',
  'send_broadcast',
  'manage_pipeline',
  'manage_contacts',
  'manage_tasks',
  'webhook',
] as const;

export type AiAgentTool = (typeof AI_AGENT_TOOL_REGISTRY)[number];

/** Built-in employee role metadata (title + suggested responsibilities). */
export const AI_EMPLOYEE_ROLES: Array<{
  role: Exclude<AiAgentRole, 'co_founder'>;
  title: string;
  responsibilities: string[];
  tools: AiAgentTool[];
  instructions: string;
}> = [
  {
    role: 'sales',
    title: 'Sales AI',
    responsibilities: [
      'Qualify inbound leads and route them through the pipeline',
      'Follow up on open deals and chase stalled opportunities',
      'Draft and send sales outreach on WhatsApp',
      'Report won/lost and pipeline health to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'send_whatsapp', 'manage_pipeline', 'manage_contacts'],
    instructions:
      'You are the Sales AI. You own the revenue pipeline: qualification, follow-up, and closing support. Report pipeline health and win/loss to the AI Co-Founder. Escalate anything you cannot close or that affects revenue.',
  },
  {
    role: 'marketing',
    title: 'Marketing AI',
    responsibilities: [
      'Plan and draft broadcast campaigns and templates',
      'Segment contacts for campaigns',
      'Analyze campaign delivery and reply rates',
      'Propose promotions and content to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'send_broadcast', 'manage_contacts'],
    instructions:
      'You are the Marketing AI. You plan campaigns, segment audiences, and analyze broadcast performance. Report campaign results and proposed promotions to the AI Co-Founder.',
  },
  {
    role: 'support',
    title: 'Support AI',
    responsibilities: [
      'Answer customer support questions from the knowledge base',
      'Detect unhappy customers and escalate urgent threads',
      'Draft replies agents can review in the inbox',
      'Summarize recurring support issues for the Co-Founder',
    ],
    tools: ['analyze', 'report', 'review', 'send_whatsapp'],
    instructions:
      'You are the Support AI. You help ensure customers are supported well: draft helpful replies, escalate unhappy threads, and surface recurring issues. Report to the AI Co-Founder.',
  },
  {
    role: 'operations',
    title: 'Operations AI',
    responsibilities: [
      'Monitor automations and flows for failures',
      'Keep data clean (dedupe contacts, fix gaps)',
      'Track response times and workload across the inbox',
      'Report operational issues to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'review', 'manage_contacts'],
    instructions:
      'You are the Operations AI. You watch the machinery: automations, flows, data quality, response times. Fix what you can and flag operational problems to the AI Co-Founder.',
  },
  {
    role: 'social',
    title: 'Social Media AI',
    responsibilities: [
      'Draft posts and replies for Instagram / Messenger',
      'Track follower/engagement signals',
      'Handle social inbound conversations in the unified inbox',
      'Report social sentiment to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'send_whatsapp'],
    instructions:
      'You are the Social Media AI. You handle Instagram and Messenger conversations, draft social content, and track engagement. Report to the AI Co-Founder.',
  },
  {
    role: 'finance',
    title: 'Finance AI',
    responsibilities: [
      'Monitor deal values and pipeline revenue',
      'Flag anomalies and cash-flow-relevant signals',
      'Prepare revenue summaries and forecasts',
      'Report financial health to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'manage_pipeline'],
    instructions:
      'You are the Finance AI. You watch the numbers: deal value, revenue, pipeline totals. Produce clear summaries and flag financial risks to the AI Co-Founder.',
  },
  {
    role: 'hr',
    title: 'HR AI',
    responsibilities: [
      'Track team roles and member onboarding',
      'Suggest coverage when response times slip',
      'Help draft internal notices',
      'Report team/ops issues to the Co-Founder',
    ],
    tools: ['analyze', 'report', 'review'],
    instructions:
      'You are the HR AI. You look after the human team and its coverage. Report team health and staffing suggestions to the AI Co-Founder.',
  },
];
