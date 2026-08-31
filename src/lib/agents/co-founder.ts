// ============================================================
// AI Co-Founder orchestration — the brain of the AI organization.
//
// The Co-Founder:
//   1. Loads a business snapshot (see context.ts).
//   2. Asks its configured LLM to analyze the business, produce
//      recommendations, and optionally delegate tasks to its AI
//      employees (or to itself).
//   3. Persists generated tasks + activity so the org page reflects
//      what "it" decided, and so later runs can pick up escalations.
//
// All AI calls reuse the account's existing bring-your-own-key config
// (src/lib/ai/config.ts + providers) — there is no separate provider
// or key for the Co-Founder. If no AI is configured, the Co-Founder
// degrades gracefully to a deterministic digest (still useful, no LLM
// spend).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import type { ChatMessage } from '@/lib/ai/types'
import { buildBusinessSnapshot } from './context'

export interface GeneratedTask {
  title: string
  description: string
  assigneeName: string // matched against an existing AI employee by name
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueInDays?: number | null
}

export interface CoFounderOutcome {
  analysis: string
  recommendations: string[]
  problems: string[]
  opportunities: string[]
  tasks: GeneratedTask[]
  report: string // owner-facing summary
}

/**
 * Ask the Co-Founder's LLM to analyze the business and propose work.
 * `directive` lets a caller steer a run (e.g. "focus on sales").
 * Returns the structured outcome. Never throws for model-level issues —
 * falls back to a digest on failure.
 */
export async function runCoFounderAnalysis(
  db: SupabaseClient,
  accountId: string,
  directive = '',
): Promise<CoFounderOutcome> {
  const snapshot = await buildBusinessSnapshot(db, accountId)

  const model = await loadAiConfig(db, accountId, { requireActive: false })
  if (!model || !model.apiKey) {
    return fallbackDigest(directive)
  }

  const systemPrompt = [
    'You are the AI Co-Founder of a small business operating a WhatsApp CRM.',
    'You analyze the business, give recommendations, spot problems and opportunities,',
    'and propose concrete tasks for the AI employees below you.',
    'Respond with strict JSON only — no markdown, no code fences. Use this shape:',
    JSON.stringify({
      analysis: '2-3 sentence business assessment',
      recommendations: ['concrete recommendations'],
      problems: ['urgent problems if any'],
      opportunities: ['opportunities if any'],
      tasks: [
        {
          title: 'short task title',
          description: 'what to do and why',
          assigneeName: 'name of an AI employee (e.g. Sales AI, or AI Co-Founder)',
          priority: 'medium',
          dueInDays: 3,
        },
      ],
      report: 'one short paragraph the business owner can read as a summary',
    }, null, 2),
  ].join('\n\n')

  const userContent = [
    `Here is the current business snapshot (JSON):`,
    JSON.stringify(snapshot, null, 2),
    directive ? `\nOwner directive: ${directive}` : '',
    '\nNow analyze and return the JSON.',
  ].join('\n')

  const messages: ChatMessage[] = [{ role: 'user', content: userContent }]

  try {
    const result = await generateReply({
      config: model,
      systemPrompt,
      messages,
    })
    return parseOutcome(result.text)
  } catch (err) {
    console.error('[co-founder] LLM analysis failed, using digest:', err)
    return fallbackDigest(directive)
  }
}

/** Best-effort parse of the model's JSON (tolerates stray prose). */
export function parseOutcome(raw: string): CoFounderOutcome {
  const fallback = fallbackDigest('')
  try {
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
    const obj = JSON.parse(cleaned) as Partial<CoFounderOutcome>
    return {
      analysis: typeof obj.analysis === 'string' ? obj.analysis : fallback.analysis,
      recommendations: Array.isArray(obj.recommendations) ? (obj.recommendations as string[]) : fallback.recommendations,
      problems: Array.isArray(obj.problems) ? (obj.problems as string[]) : fallback.problems,
      opportunities: Array.isArray(obj.opportunities) ? (obj.opportunities as string[]) : fallback.opportunities,
      tasks: Array.isArray(obj.tasks) ? (obj.tasks as GeneratedTask[]) : fallback.tasks,
      report: typeof obj.report === 'string' ? obj.report : fallback.report,
    }
  } catch {
    return fallback
  }
}

/**
 * Persist the Co-Founder's proposed tasks onto real AI employees by
 * name, plus an activity trail. Returns counts of what got created.
 * Unknown assignee names are skipped (never silently generate agents).
 */
export async function delegateGeneratedTasks(
  db: SupabaseClient,
  accountId: string,
  coFounderId: string,
  tasks: GeneratedTask[],
): Promise<{ created: number; skipped: number }> {
  const { data: agents } = await db.from('ai_agents').select('id, name').eq('account_id', accountId)

  let created = 0
  let skipped = 0
  for (const t of tasks) {
    const assignee = (agents ?? []).find(
      (a) => a.name.toLowerCase().trim() === t.assigneeName.toLowerCase().trim(),
    )
    if (!assignee) {
      skipped++
      continue
    }
    const insert: Record<string, unknown> = {
      account_id: accountId,
      assignee_agent_id: assignee.id,
      created_by_agent_id: coFounderId,
      title: t.title,
      description: t.description ?? null,
      priority: t.priority ?? 'medium',
      status: 'todo',
    }
    if (t.dueInDays) {
      insert.due_at = new Date(Date.now() + t.dueInDays * 24 * 3600 * 1000).toISOString()
    }
    const { error } = await db.from('ai_tasks').insert(insert)
    if (error) {
      console.error('[co-founder] task insert failed:', error)
      skipped++
      continue
    }
    created++
    await logActivity(db, accountId, coFounderId, 'task_delegated', `Delegated "${t.title}" to ${assignee.name}`, {
      assignee_agent_id: assignee.id,
      title: t.title,
    })
  }
  return { created, skipped }
}

/** Append an entry to the agent activity trail (best-effort). */
export async function logActivity(
  db: SupabaseClient,
  accountId: string,
  agentId: string | null,
  type: string,
  summary: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from('agent_activity_log').insert({
      account_id: accountId,
      agent_id: agentId,
      type,
      summary,
      metadata,
    })
  } catch (err) {
    // Activity logging must never break the caller.
    console.error('[agent activity] log failed:', err)
  }
}

/** Deterministic digest when no LLM is configured or the call fails. */
function fallbackDigest(directive: string): CoFounderOutcome {
  const focus = directive ? ` (directive: ${directive})` : ''
  return {
    analysis: `AI Co-Founder mode is active${focus}. Configure an OpenAI or Anthropic key under AI Agents → Setup to unlock full business analysis.`,
    recommendations: [
      'Connect an OpenAI or Anthropic API key in AI Agents → Setup to enable the AI Co-Founder.',
    ],
    problems: [],
    opportunities: [],
    tasks: [],
    report:
      'AI Co-Founder is ready. Add an AI provider key to enable automatic analysis, recommendations, and task delegation.',
  }
}
