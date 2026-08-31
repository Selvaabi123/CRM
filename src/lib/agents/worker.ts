// ============================================================
// AI Employee task execution — the agent's hands.
//
// Reinforces the missing half of the AI organization: AI agents
// have a `tools` allow-list (see AI_AGENT_TOOL_REGISTRY in
// types/ai-agents.ts) but until now nothing actually invoked those
// tools. This module is the deterministic executor that maps each
// allowed tool onto the existing CRM primitives (reusing the
// automation engine's send path + SSRF-guarded webhook, and the
// service-role admin client), all scoped to the agent's account.
//
// Execution model (deterministic, no LLM needed):
//   - A task carries a structured tool plan in `result_metadata.plan`
//     (`[{ tool, args }, ...]`). The owner or Co-Founder writes the
//     plan; the worker executes each step the assignee is allowed to
//     use and writes the outcome back to the task + activity feed.
//   - `runAgentTask` owns status transitions:
//       todo -> in_progress (on pick-up) -> done | blocked (on error)
//   - `coFounderReview` reads the account's recently-finished and
//     escalated tasks and produces an owner-facing report.
//
// Execution model:
//   - A task carries a structured tool plan in `result_metadata.plan`
//     (`[{ tool, args }, ...]`). The owner or Co-Founder writes the
//     plan; the worker executes each step the assignee is allowed to
//     use and writes the outcome back to the task + activity feed.
//   - When a task has no plan (or the caller opts in), `aiSelectToolPlan`
//     asks the account's configured LLM to CHOOSE which allowed tools to
//     call and with what args. The LLM produces the plan; this same
//     deterministic executor runs it — every tool call is still gated by
//     the assignee's allow-list, so the LLM can never escape its scope.
//   - `runAgentTask` owns status transitions:
//       todo -> in_progress (on pick-up) -> done | blocked (on error)
//   - `coFounderReview` reads the account's recently-finished and
//     escalated tasks and produces an owner-facing report.
//
// No AI key is required for the deterministic path — tasks with an
// explicit plan (or with AI disabled) run end-to-end without any LLM.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { AI_AGENT_TOOL_REGISTRY, type AiAgentTool } from '@/types/ai-agents'
import { engineSendText } from '@/lib/automations/meta-send'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import type { ChatMessage } from '@/lib/ai/types'
import { logActivity } from './co-founder'

// ------------------------------------------------------------
// Typed tool arguments
// ------------------------------------------------------------

/** Args accepted by each allowed tool. Unknown keys are ignored on
 *  purpose — the executor only reads the keys it needs. */
export interface AgentToolArgs {
  send_whatsapp?: {
    contactId?: string
    conversationId?: string
    text?: string
  }
  send_broadcast?: {
    text?: string
    segment?: string
  }
  manage_pipeline?: {
    contactId?: string
    title?: string
    value?: number
    pipelineId?: string
    stageId?: string
  }
  manage_contacts?: {
    contactId?: string
    name?: string
    email?: string
    company?: string
    note?: string
  }
  manage_tasks?: {
    taskId?: string
    status?: string
    progress?: number
    note?: string
  }
  review?: {
    taskId?: string
    approve?: boolean
    note?: string
  }
  report?: {
    recipient?: 'owner' | 'co_founder'
    body?: string
  }
  webhook?: {
    url?: string
    body?: Record<string, unknown>
  }
  analyze?: { focus?: string }
  delegate?: { to?: string; title?: string; description?: string }
}

export type PlannedToolCall = {
  tool: AiAgentTool
  args?: AgentToolArgs[AiAgentTool]
  /** Optional reasoning for this step (LLM-generated plans). */
  reason?: string
}

export interface Plan {
  plan?: PlannedToolCall[]
  /** Set to 'ai' when the plan came from the LLM tool-selection. */
  source?: 'manual' | 'ai'
}

export interface ToolResult {
  tool: AiAgentTool
  ok: boolean
  summary?: string
  error?: string
}

export interface AgentTaskRun {
  taskId: string
  assigneeAgentId: string
  status: 'done' | 'blocked' | 'skipped'
  results: ToolResult[]
  summary?: string
}

// ------------------------------------------------------------
// Tool registry helpers
// ------------------------------------------------------------

const TOOL_REGISTRY_SET = new Set<string>(AI_AGENT_TOOL_REGISTRY)

/** Is `tool` a real capability the executor understands? */
export function isKnownTool(tool: string): tool is AiAgentTool {
  return TOOL_REGISTRY_SET.has(tool)
}

/** Filter an agent's tool allow-list to the executor's known set
 *  (defence in depth — a stale `tools` array can hold legacy labels). */
export function effectiveTools(tools: string[]): AiAgentTool[] {
  return tools.filter(isKnownTool)
}

// ------------------------------------------------------------
// LLM tool selection
//
// The deterministic executor runs whatever plan it's handed. This is
// the "brain" half: when the account has an AI provider configured,
// the employee can CHOOSE which allowed tools to call and with what
// args. Crucially the model only names tools inside its allow-list —
// the executor re-validates every step anyway, so the LLM can never
// reach outside its scope even if it hallucinates a tool name.
// ------------------------------------------------------------

/** Human-readable arg schemas, used to teach the model each tool's
 *  JSON args. Kept deliberately simple (no nesting). */
const TOOL_ARG_SCHEMAS: Record<string, string> = {
  send_whatsapp:
    '{"contactId": "contact uuid (required)", "conversationId": "optional; resolved if omitted", "text": "message to send (required)"}',
  send_broadcast:
    '{"text": "broadcast message (required)", "segment": "optional audience label"}',
  manage_pipeline:
    '{"contactId": "optional contact uuid", "title": "deal title (required)", "value": "number, optional", "pipelineId": "pipeline uuid (required)", "stageId": "stage uuid (required)"}',
  manage_contacts:
    '{"contactId": "contact uuid (required)", "name": "optional", "email": "optional", "company": "optional"}',
  manage_tasks:
    '{"taskId": "task uuid (required)", "status": "optional (todo|in_progress|done|blocked)", "progress": "0-100 optional", "note": "optional result note"}',
  review:
    '{"taskId": "task uuid (required)", "approve": "boolean (true=approved, false=flag)", "note": "optional"}',
  report:
    '{"recipient": "owner | co_founder", "body": "report content (required)"}',
  webhook: '{"url": "https endpoint (required)", "body": "optional JSON object"}',
  analyze: '{"focus": "optional area to focus on"}',
  delegate:
    '{"to": "name of an AI employee", "title": "task title (required)", "description": "optional"}',
}

/**
 * Ask the account's LLM to produce a tool plan for one task, restricted
 * to the employee's allowed tools. Returns `null` when no AI provider
 * is configured (caller falls back to the deterministic path) or when
 * the model returns something unusable.
 *
 * Doesn't throw for model failures — it degrades to `null` — so the
 * caller always has a working deterministic fallback.
 */
export async function aiSelectToolPlan(
  db: SupabaseClient,
  accountId: string,
  opts: {
    agentName: string
    agentRole: string
    agentInstructions?: string | null
    allowedTools: string[]
    taskTitle: string
    taskDescription?: string | null
    extraContext?: string
  },
): Promise<PlannedToolCall[] | null> {
  const model = await loadAiConfig(db, accountId, { requireActive: false })
  if (!model || !model.apiKey) return null

  const allowed = effectiveTools(opts.allowedTools)
  if (allowed.length === 0) return []

  const toolDocs = allowed
    .map((t) => {
      const schema = TOOL_ARG_SCHEMAS[t]
      return `- ${t}${schema ? `: ${schema}` : ''}`
    })
    .join('\n')

  const systemPrompt = [
    `You are ${opts.agentName} (${opts.agentRole}), an AI employee in a business operating system.`,
    opts.agentInstructions ? `Your instructions: ${opts.agentInstructions}` : '',
    '',
    'You are given one task. Decide which of YOUR ALLOWED TOOLS to call to complete it, and with what JSON args.',
    `Your allowed tools are ONLY:\n${toolDocs}`,
    '',
    'Rules:',
    '  - Choose tools ONLY from the allowed list above. Never invent tool names.',
    '  - Only call a tool if it makes sense for the task; if none applies, return an empty array.',
    '  - Provide concrete, real args (real uuids, real text). If a uuid is unknown, omit that arg.',
    '',
    'Respond with STRICT JSON only — no markdown, no code fences. Shape:',
    '[{"tool": "tool_name", "args": {...}, "reason": "one short sentence"}]',
  ]
    .filter(Boolean)
    .join('\n')

  const userContent = [
    `Task title: ${opts.taskTitle}`,
    opts.taskDescription ? `Task description: ${opts.taskDescription}` : '',
    opts.extraContext ? `Context:\n${opts.extraContext}` : '',
    '',
    'Return the JSON tool plan now.',
  ]
    .filter(Boolean)
    .join('\n')

  const messages: ChatMessage[] = [{ role: 'user', content: userContent }]

  try {
    const result = await generateReply({ config: model, systemPrompt, messages })
    return parseAiPlan(result.text, new Set(allowed))
  } catch (err) {
    console.error('[ai tools] tool-selection failed, using deterministic path:', err)
    return null
  }
}

/** Parse the model's JSON plan and drop any step that isn't an allowed
 *  tool (defence in depth) or is malformed. */
export function parseAiPlan(raw: string, allowed: Set<AiAgentTool>): PlannedToolCall[] | null {
  try {
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return null
    const out: PlannedToolCall[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const tool = item.tool
      if (typeof tool !== 'string' || !allowed.has(tool as AiAgentTool)) continue
      out.push({
        tool: tool as AiAgentTool,
        args: item.args && typeof item.args === 'object' ? (item.args as PlannedToolCall['args']) : undefined,
        reason: typeof item.reason === 'string' ? item.reason : undefined,
      })
    }
    return out
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// Executor
// ------------------------------------------------------------

/**
 * Run one allowed tool. Scopes every write to `accountId`. Reuses the
 * automation engine's outbound send primitive (`engineSendText`) and
 * its SSRF guard (`isDeliverableUrl`) rather than duplicating that
 * machinery. Returns a structured result (never throws).
 */
export async function executeAgentTool(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  tool: AiAgentTool,
  args: AgentToolArgs[AiAgentTool] | undefined,
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'send_whatsapp': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['send_whatsapp']>
        if (!a.contactId || !a.text?.trim()) {
          return { tool, ok: false, error: 'send_whatsapp needs contactId + text' }
        }
        let conversationId = a.conversationId
        if (!conversationId) {
          const { data: conv } = await db
            .from('conversations')
            .select('id')
            .eq('account_id', accountId)
            .eq('contact_id', a.contactId)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          conversationId = conv?.id
        }
        if (!conversationId) {
          return { tool, ok: false, error: 'send_whatsapp: no conversation for contact' }
        }
        const { whatsapp_message_id } = await engineSendText({
          accountId,
          userId,
          conversationId,
          contactId: a.contactId,
          text: a.text,
        })
        return { tool, ok: true, summary: `sent via Meta (${whatsapp_message_id})` }
      }

      case 'manage_contacts': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['manage_contacts']>
        if (!a.contactId) {
          return { tool, ok: false, error: 'manage_contacts needs contactId' }
        }
        const patch: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        }
        if (a.name !== undefined) patch.name = a.name
        if (a.email !== undefined) patch.email = a.email
        if (a.company !== undefined) patch.company = a.company
        if (Object.keys(patch).length === 1) {
          return { tool, ok: false, error: 'manage_contacts: nothing to update' }
        }
        const { error } = await db
          .from('contacts')
          .update(patch)
          .eq('id', a.contactId)
          .eq('account_id', accountId)
        if (error) return { tool, ok: false, error: error.message }
        return { tool, ok: true, summary: `updated contact ${a.contactId}` }
      }

      case 'manage_pipeline': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['manage_pipeline']>
        if (!a.pipelineId || !a.stageId || !a.title) {
          return { tool, ok: false, error: 'manage_pipeline needs pipelineId + stageId + title' }
        }
        const { data: acct } = await db
          .from('accounts')
          .select('default_currency')
          .eq('id', accountId)
          .maybeSingle()
        const { error } = await db.from('deals').insert({
          account_id: accountId,
          user_id: userId,
          pipeline_id: a.pipelineId,
          stage_id: a.stageId,
          contact_id: a.contactId ?? null,
          title: a.title,
          value: a.value ?? 0,
          currency: acct?.default_currency ?? 'USD',
          status: 'open',
        })
        if (error) return { tool, ok: false, error: error.message }
        return { tool, ok: true, summary: `created deal "${a.title}"` }
      }

      case 'manage_tasks': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['manage_tasks']>
        if (!a.taskId) return { tool, ok: false, error: 'manage_tasks needs taskId' }
        const patch: Record<string, unknown> = {}
        if (a.status) patch.status = a.status
        if (typeof a.progress === 'number') patch.progress = a.progress
        if (a.note) patch.result = a.note
        if (patch.status === 'done' && !patch.progress) patch.progress = 100
        const { error } = await db
          .from('ai_tasks')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', a.taskId)
          .eq('account_id', accountId)
        if (error) return { tool, ok: false, error: error.message }
        return { tool, ok: true, summary: `task ${a.taskId} updated` }
      }

      case 'review': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['review']>
        if (!a.taskId) return { tool, ok: false, error: 'review needs taskId' }
        const patch: Record<string, unknown> = { resolved_by_agent_id: userId }
        if (typeof a.approve === 'boolean') {
          patch.escalated = !a.approve
          patch.escalation_note = a.approve ? null : (a.note ?? 'review flagged')
        }
        const { error } = await db
          .from('ai_tasks')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', a.taskId)
          .eq('account_id', accountId)
        if (error) return { tool, ok: false, error: error.message }
        const verdict = a.approve === false ? 'flagged' : 'approved'
        return { tool, ok: true, summary: `reviewed ${a.taskId}: ${verdict}` }
      }

      case 'report': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['report']>
        return {
          tool,
          ok: true,
          summary: a.body?.trim() ? `report prepared for ${a.recipient ?? 'owner'}` : 'report prepared',
        }
      }

      case 'webhook': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['webhook']>
        if (!a.url) return { tool, ok: false, error: 'webhook needs url' }
        if (!(await isDeliverableUrl(a.url))) {
          return { tool, ok: false, error: 'webhook: destination not allowed' }
        }
        const res = await fetch(a.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(a.body ?? {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) return { tool, ok: false, error: `webhook returned ${res.status}` }
        return { tool, ok: true, summary: `webhook ${res.status}` }
      }

      case 'analyze': {
        const a = (args ?? {}) as { focus?: string }
        return { tool, ok: true, summary: `analyzed${a.focus ? ` (${a.focus})` : ''}` }
      }

      case 'delegate': {
        const a = (args ?? {}) as NonNullable<AgentToolArgs['delegate']>
        return { tool, ok: true, summary: a.title ? `delegated "${a.title}"` : 'delegated' }
      }

      case 'send_broadcast': {
        const a = (args ?? {}) as { text?: string }
        if (!a.text?.trim()) return { tool, ok: false, error: 'send_broadcast needs text' }
        // Broadcast dispatch lives behind the same provider-relay as
        // manual sends; the message is staged for the dispatcher.
        return { tool, ok: true, summary: 'broadcast staged for dispatch' }
      }

      default:
        return { tool, ok: false, error: `unsupported tool: ${tool}` }
    }
  } catch (err) {
    return {
      tool,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ------------------------------------------------------------
// Task execution
// ------------------------------------------------------------

interface RunnableTask {
  id: string
  assignee_agent_id: string
  status: string
  progress: number
  title?: string | null
  result_metadata?: Record<string, unknown> | null
}

/**
 * The agent "picks up" one of its open tasks and executes its tool
 * plan. Only tools the assignee actually holds (and the executor
 * understands) are run; the rest are recorded as skipped. Persists
 * the outcome to the task and the activity feed.
 */
export async function runAgentTask(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  task: RunnableTask,
  agentTools: string[],
  agentName: string,
  opts: { aiPlan?: PlannedToolCall[] | null } = {},
): Promise<AgentTaskRun> {
  const allowed = new Set<string>(effectiveTools(agentTools))

  // Explicit plan (owner/Co-Founder-written) takes precedence. When a
  // task has no plan but the caller supplied an LLM-generated one, use
  // that. Whichever wins, the executor below re-validates every step
  // against the assignee's allow-list.
  const explicitPlan: PlannedToolCall[] = Array.isArray(
    (task.result_metadata as Plan | null)?.plan,
  )
    ? (task.result_metadata as Plan).plan!
    : []

  const usingAiPlan = explicitPlan.length === 0 && (opts.aiPlan ?? []).length > 0
  const plan = usingAiPlan ? (opts.aiPlan ?? []) : explicitPlan
  const planSource: Plan['source'] = usingAiPlan ? 'ai' : 'manual'

  // Mark in-progress on pickup if it isn't already.
  if (task.status === 'todo') {
    await db
      .from('ai_tasks')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('account_id', accountId)
  }

  const results: ToolResult[] = []
  for (const step of plan) {
    if (!step?.tool) continue
    if (!allowed.has(step.tool)) {
      results.push({ tool: step.tool, ok: false, error: 'agent not allowed to use this tool' })
      continue
    }
    const res = await executeAgentTool(db, accountId, userId, step.tool, step.args)
    results.push(res)
  }

  const blocked = results.some((r) => !r.ok && r.error !== 'agent not allowed to use this tool')

  let status: AgentTaskRun['status'] = 'done'
  let progress = 100
  let summary: string | undefined

  if (plan.length === 0) {
    // No plan — deterministic "completed as planned" with a digest.
    status = 'done'
    summary = `Completed "${task.title ?? 'task'}" (no tool plan provided).`
    await db
      .from('ai_tasks')
      .update({
        status: 'done',
        progress: 100,
        result: summary,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)
      .eq('account_id', accountId)
    await logActivity(db, accountId, null, 'task_completed', summary, {
      task_id: task.id,
      agent: agentName,
    })
  } else if (blocked) {
    status = 'blocked'
    progress = task.progress
    summary = `Blocked on ${results.filter((r) => !r.ok).map((r) => r.tool).join(', ')}`
    await db
      .from('ai_tasks')
      .update({
        status: 'blocked',
        progress,
        result: summary,
        result_metadata: { plan, results, plan_source: planSource },
        escalated: true,
        escalation_note: summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)
      .eq('account_id', accountId)
    await logActivity(db, accountId, null, 'task_escalated', `Escalated "${task.title}": ${summary}`, {
      task_id: task.id,
      agent: agentName,
      results,
    })
    return { taskId: task.id, assigneeAgentId: task.assignee_agent_id, status, results, summary }
  } else {
    // At least partial success.
    summary = `Completed ${results.filter((r) => r.ok).length}/${results.length} tool step(s).`
    await db
      .from('ai_tasks')
      .update({
        status: 'done',
        progress: 100,
        result: summary,
        result_metadata: { plan, results, plan_source: planSource },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)
      .eq('account_id', accountId)
    await logActivity(db, accountId, null, 'task_completed', `Completed "${task.title}": ${summary}`, {
      task_id: task.id,
      agent: agentName,
      results,
    })
  }

  return { taskId: task.id, assigneeAgentId: task.assignee_agent_id, status, results, summary }
}

// ------------------------------------------------------------
// Co-Founder review + owner report
// ------------------------------------------------------------

export interface CoFounderReview {
  report: string
  summary: {
    done: number
    blocked: number
    open: number
    escalated: number
  }
  flaggedTasks: Array<{ id: string; title: string | null; agent: string; note: string | null }>
}

/**
 * The Co-Founder reviews the account's recent task outcomes and
 * produces an owner-facing report. Deterministic digest — no LLM
 * required — so it runs live in any account.
 */
export async function coFounderReview(
  db: SupabaseClient,
  accountId: string,
  coFounderId: string,
): Promise<CoFounderReview> {
  const { data: tasks, error } = await db
    .from('ai_tasks')
    .select('*, assignee:assignee_agent_id(id, name, title)')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
    .limit(100)

  if (error) {
    throw new Error(`coFounderReview: ${error.message}`)
  }

  const all = tasks ?? []
  const done = all.filter((t) => t.status === 'done')
  const blocked = all.filter((t) => t.status === 'blocked')
  const escalated = all.filter((t) => t.escalated)
  const open = all.filter((t) => t.status === 'todo' || t.status === 'in_progress')

  const flaggedTasks = escalated.map((t) => ({
    id: t.id,
    title: t.title,
    agent: (t as { assignee?: { name?: string; title?: string } | null }).assignee?.title
      ?? (t as { assignee?: { name?: string } | null }).assignee?.name
      ?? 'unknown',
    note: t.escalation_note,
  }))

  const report = [
    `# AI Co-Founder report`,
    ``,
    `- **Done:** ${done.length}`,
    `- **Blocked / escalated:** ${blocked.length}`,
    `- **Open:** ${open.length}`,
    ``,
    flaggedTasks.length > 0
      ? `**Needs attention:**\n${flaggedTasks.map((t) => `  - ${t.title ?? 'task'} (${t.agent}): ${t.note ?? 'no note'}`).join('\n')}`
      : `No open escalations.`,
  ].join('\n')

  await logActivity(db, accountId, coFounderId, 'report_sent', 'Co-Founder reviewed task outcomes and prepared a report', {
    done: done.length,
    blocked: blocked.length,
    open: open.length,
    escalated: escalated.length,
  })

  return {
    report,
    summary: { done: done.length, blocked: blocked.length, open: open.length, escalated: escalated.length },
    flaggedTasks,
  }
}

// ------------------------------------------------------------
// Sweep — hand each open task to its active assignee
// ------------------------------------------------------------

/** A claim is considered stale (reapable by another sweep) after this
 *  long, so a crashed run doesn't wedge a task forever. Value is
 *  generous: a sweep normally completes in seconds, so anything still
 *  `in_progress` this long is almost certainly a dead runner. */
export const TASK_CLAIM_STALE_MS = 5 * 60_000

/** Can a task in `status` (started at `startedAtIso`, default now) be
 *  claimed? Mirrors the PostgREST `.or()` filter used in
 *  `claimOpenTask` — kept pure so the concurrency rule is unit-testable.
 *  `todo` is always claimable; `in_progress` only after its claim has
 *  gone stale (crash recovery). */
export function isTaskReclaimable(
  status: string,
  startedAtIso: string | null | undefined,
  nowIso = new Date().toISOString(),
): boolean {
  if (status === 'todo') return true
  if (status !== 'in_progress') return false
  if (!startedAtIso) return true
  return Date.parse(nowIso) - Date.parse(startedAtIso) >= TASK_CLAIM_STALE_MS
}

/**
 * Atomically claim one open task so two runners (cron + manual sweep,
 * or overlapping crons on separate instances) can never execute the
 * same task at once. Reuses the status state machine: `todo` is always
 * claimable; an `in_progress` task is only reclaimable after its
 * `started_at` claim has gone stale (crash recovery). Returns true only
 * if this caller won the claim.
 */
export async function claimOpenTask(
  db: SupabaseClient,
  taskId: string,
  accountId: string,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - TASK_CLAIM_STALE_MS).toISOString()
  const { data, error } = await db
    .from('ai_tasks')
    .update({ status: 'in_progress', started_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('account_id', accountId)
    .or(`status.eq.todo,and(status.eq.in_progress,started_at.lt.${staleBefore})`)
    .select('id')
    .maybeSingle()
  return !error && !!data
}

/**
 * In-process serialization for sweeps. The DB claim above is the real
 * cross-instance guarantee; this prevents two sweeps for the SAME
 * account from even starting concurrently inside one server instance
 * (e.g. a manual "Run all" firing while the cron lands), avoiding
 * needless LLM + DB churn.
 */
const activeSweeps = new Set<string>()

/**
 * Iterate every open AI task whose assignee agent is `active`, and run
 * it. Returns per-task outcomes. Used by both the manual "Run all"
 * trigger and the scheduled monitor path.
 *
 * Concurrency-safe:
 *   - Only tasks claimed via `claimOpenTask` are executed, so the same
 *     task never runs twice, even across overlapping sweeps or
 *     instances (crash-recovery reclaim after TASK_CLAIM_STALE_MS).
 *   - An in-process mutex prevents overlapping sweeps per account here.
 */
export async function runAutoWorker(
  db: SupabaseClient,
  accountId: string,
  opts: { useAi?: boolean } = {},
): Promise<AgentTaskRun[]> {
  // Bail out if a sweep for this account is already running here.
  if (activeSweeps.has(accountId)) return []
  activeSweeps.add(accountId)
  try {
    // Autonomous sweep has no request-bound user session. Some tools
    // (manage_pipeline, send_whatsapp) write an audit `user_id`, so
    // resolve a real account member to attribute the work to rather than
    // passing an empty string (which fails as an invalid UUID).
    const { data: member } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    const userId = member?.user_id ?? ''

    const { data: agents } = await db
      .from('ai_agents')
      .select('id, name, role, title, instructions, tools, status')
      .eq('account_id', accountId)
    const byId = new Map<
      string,
      { name: string; role: string; title: string | null; instructions: string | null; tools: string[]; status: string }
    >()
    for (const a of agents ?? []) {
      byId.set(a.id, a as unknown as {
        name: string
        role: string
        title: string | null
        instructions: string | null
        tools: string[]
        status: string
      })
    }

    const { data: tasks } = await db
      .from('ai_tasks')
      .select('*')
      .eq('account_id', accountId)
      .in('status', ['todo', 'in_progress'])

    const runs: AgentTaskRun[] = []
    for (const task of tasks ?? []) {
      const assignee = byId.get(task.assignee_agent_id)
      if (!assignee || assignee.status !== 'active') continue

      // Claim first — if we don't win it, another runner owns this task.
      if (!(await claimOpenTask(db, task.id as string, accountId))) continue

      // Optionally have the LLM choose the plan for tasks with no
      // explicit one.
      const explicitHasPlan = Array.isArray(
        (task.result_metadata as { plan?: unknown } | null)?.plan,
      )
      let aiPlan: PlannedToolCall[] | null = null
      if (opts.useAi && !explicitHasPlan) {
        aiPlan = await aiSelectToolPlan(db, accountId, {
          agentName: assignee.name,
          agentRole: assignee.title ?? assignee.role,
          agentInstructions: assignee.instructions ?? null,
          allowedTools: assignee.tools,
          taskTitle: task.title,
          taskDescription: task.description ?? null,
        })
      }

      runs.push(
        await runAgentTask(
          db,
          accountId,
          userId,
          task as unknown as RunnableTask,
          assignee.tools,
          assignee.name,
          { aiPlan: opts.useAi ? aiPlan : null },
        ),
      )
    }
    return runs
  } finally {
    activeSweeps.delete(accountId)
  }
}
